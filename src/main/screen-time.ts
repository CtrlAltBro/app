import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { powerMonitor } from 'electron';
import type { ScreenTimeSession } from '../shared/api-types';
import { knownAppName } from '../core/inventory';

// Foreground sensor, on the child's desktop. Screen time = time an app is in the
// foreground while the session is unlocked and the PC awake. Windows locks the session
// after inactivity unless a video keeps the screen on, so no idle threshold.
// Finished sessions go to the core's upload queue (core/screen-time-queue.ts).

const TICK_MS = 5_000;
// A gap longer than this between ticks means the PC slept.
const GAP_MS = 30_000;
// Sessions are cut so the dashboard (and daily limits) see usage while an app stays open.
const MAX_SESSION_MS = 60 * 1000;
const RESTART_DELAY_MS = 5_000;
const EXE_NAME = /^[^\\/:*?"<>|]{1,255}\.exe$/;
const WINDOWS_DIR = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase() + '\\';
// Store apps are drawn by this host process; their window title is the app name.
const STORE_HOST = 'applicationframehost.exe';

// Prints "<exe path>\t<window title>\t<left,top,right,bottom>" for the foreground window
// every tick. DPI aware, so the rectangle is in physical pixels.
const FOREGROUND_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Namespace CtrlAltBro -Name Win -MemberDefinition @'
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
[void][CtrlAltBro.Win]::SetProcessDPIAware()
$text = New-Object System.Text.StringBuilder 512
$rect = New-Object CtrlAltBro.Win+RECT
while ($true) {
  $procId = 0
  $hwnd = [CtrlAltBro.Win]::GetForegroundWindow()
  [void][CtrlAltBro.Win]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  [void][CtrlAltBro.Win]::GetWindowText($hwnd, $text, 512)
  $bounds = if ([CtrlAltBro.Win]::GetWindowRect($hwnd, [ref]$rect)) { @($rect.Left, $rect.Top, $rect.Right, $rect.Bottom) -join ',' } else { '' }
  # PID 0 means no foreground window (lock screen, desktop switch).
  $p = if ($procId) { Get-Process -Id $procId -ErrorAction SilentlyContinue } else { $null }
  $exe = if ($p.Path) { $p.Path } elseif ($p) { $p.ProcessName + '.exe' } else { '' }
  [Console]::Out.WriteLine($exe + [char]9 + ($text.ToString() -replace '\\s+', ' ') + [char]9 + $bounds)
  Start-Sleep -Milliseconds ${TICK_MS}
}
`;

// Foreground window rectangle, physical pixels.
export type WindowRect = { left: number; top: number; right: number; bottom: number };
type Foreground = { exePath: string; title: string; rect: WindowRect | null };
type Current = ScreenTimeSession & { key: string; startMs: number; lastMs: number };

export type SensorEvents = {
  // A finished session, to queue for upload.
  session(session: ScreenTimeSession): void;
  // Every tick: the counted foreground app (null when locked, idle desktop, system UI)
  // and the time since the previous tick. Used by the daily limits.
  foreground(exeName: string | null, elapsedMs: number): void;
  // Session locked or PC going to sleep: a good moment to upload.
  leave(): void;
};

let events: SensorEvents | null = null;
let current: Current | null = null;
let latest: Foreground | null = null;
let watcher: ChildProcess | null = null;
let timer: NodeJS.Timeout | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let lastTickMs = 0;

// Where the foreground window was at the last tick (for the "time's up" screen).
export const foregroundRect = () => latest?.rect ?? null;

function describe({ exePath, title }: Foreground) {
  const exeName = path.win32.basename(exePath).toLowerCase();
  if (!exePath || (exePath.toLowerCase().startsWith(WINDOWS_DIR) && exeName !== STORE_HOST)) return null;
  if (exePath.toLowerCase() === process.execPath.toLowerCase()) return null;
  if (exeName === STORE_HOST) {
    return title ? { key: `store:${title}`, app: title.slice(0, 255), exeName: undefined, title: undefined } : null;
  }
  const app = (knownAppName(exeName) ?? path.win32.basename(exePath, '.exe')).slice(0, 255);
  return { key: exeName, app, exeName: EXE_NAME.test(exeName) ? exeName : undefined, title: title.slice(0, 1000) || undefined };
}

function close() {
  if (!current) return;
  const { id, app, exeName, title, startedAt, startMs, lastMs } = current;
  current = null;
  if (lastMs - startMs < 1000) return;
  events?.session({ id, app, exeName, title, startedAt, endedAt: new Date(lastMs).toISOString() });
}

function tick() {
  const now = Date.now();
  const elapsedMs = lastTickMs ? now - lastTickMs : 0;
  const slept = elapsedMs > GAP_MS;
  lastTickMs = now;
  if (slept) close();

  const locked = powerMonitor.getSystemIdleState(1) === 'locked';
  const fg = !locked && latest ? describe(latest) : null;
  events?.foreground(fg?.exeName ?? null, slept ? 0 : elapsedMs);

  if (current && (!fg || fg.key !== current.key || now - current.startMs >= MAX_SESSION_MS)) {
    if (!slept) current.lastMs = now;
    close();
  }
  if (!fg) return;
  if (current) {
    current.lastMs = now;
    if (fg.title) current.title = fg.title;
    return;
  }
  const { key, ...rest } = fg;
  current = { id: randomUUID(), ...rest, startedAt: new Date(now).toISOString(), endedAt: '', key, startMs: now, lastMs: now };
}

function spawnWatcher() {
  const script = Buffer.from(FOREGROUND_SCRIPT, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], { windowsHide: true });
  watcher = child;
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const [exePath = '', title = '', bounds = ''] = line.split('\t');
    const [left, top, right, bottom] = bounds.split(',').map(Number);
    const rect = right > left && bottom > top ? { left, top, right, bottom } : null;
    latest = { exePath: exePath.trim(), title: title.trim(), rect };
  });
  child.on('exit', () => {
    if (watcher !== child) return;
    latest = null;
    // Killed or crashed while tracking: start it again.
    restartTimer = setTimeout(spawnWatcher, RESTART_DELAY_MS);
  });
}

export function startScreenTime(handlers: SensorEvents) {
  if (process.platform !== 'win32' || watcher) return;
  events = handlers;
  spawnWatcher();

  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('lock-screen', onSuspend);
  timer = setInterval(tick, TICK_MS);
}

function onSuspend() {
  close();
  events?.leave();
}

// Hands the running session to the queue (app quit, Windows shutdown).
export function saveCurrentSession() {
  close();
}

// discard: drop the running session instead of queuing it (device unpaired).
export function stopScreenTime({ discard = false } = {}) {
  clearInterval(timer);
  clearTimeout(restartTimer);
  powerMonitor.off('suspend', onSuspend);
  powerMonitor.off('lock-screen', onSuspend);
  const child = watcher;
  watcher = null;
  child?.kill();
  if (discard) current = null;
  close();
  latest = null;
  lastTickMs = 0;
  events = null;
}
