import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { powerMonitor } from 'electron';
import type { ScreenTimeSession } from '../shared/api-types';
import { knownAppName } from './inventory';
import { readJson, removeJson, writeJson } from './storage';

// Screen time = time an app is in the foreground while the session is unlocked and the PC awake.
// Windows locks the session after inactivity unless a video keeps the screen on, so no idle threshold.

const QUEUE_FILE = 'screen-time-queue.json';
const TICK_MS = 5_000;
// A gap longer than this between ticks means the PC slept.
const GAP_MS = 30_000;
// Sessions are cut so the dashboard (and daily limits) see usage while an app stays open.
const MAX_SESSION_MS = 60 * 1000;
const MAX_QUEUE = 10_000;
const RESTART_DELAY_MS = 5_000;
const EXE_NAME = /^[^\\/:*?"<>|]{1,255}\.exe$/;
const WINDOWS_DIR = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase() + '\\';
// Store apps are drawn by this host process; their window title is the app name.
const STORE_HOST = 'applicationframehost.exe';

// Prints "<exe path>\t<window title>" for the foreground window every tick.
const FOREGROUND_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Namespace CtrlAltBro -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
'@
$text = New-Object System.Text.StringBuilder 512
while ($true) {
  $procId = 0
  $hwnd = [CtrlAltBro.Win]::GetForegroundWindow()
  [void][CtrlAltBro.Win]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  [void][CtrlAltBro.Win]::GetWindowText($hwnd, $text, 512)
  # PID 0 means no foreground window (lock screen, desktop switch).
  $p = if ($procId) { Get-Process -Id $procId -ErrorAction SilentlyContinue } else { $null }
  $exe = if ($p.Path) { $p.Path } elseif ($p) { $p.ProcessName + '.exe' } else { '' }
  [Console]::Out.WriteLine($exe + [char]9 + ($text.ToString() -replace '\\s+', ' '))
  Start-Sleep -Milliseconds ${TICK_MS}
}
`;

type Foreground = { exePath: string; title: string };
type Current = ScreenTimeSession & { key: string; startMs: number; lastMs: number };

let queue: ScreenTimeSession[] = [];
let current: Current | null = null;
let latest: Foreground | null = null;
let watcher: ChildProcess | null = null;
let timer: NodeJS.Timeout | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let lastTickMs = 0;

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

async function persist() {
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  await writeJson(QUEUE_FILE, queue);
}

function close() {
  if (!current) return;
  const { id, app, exeName, title, startedAt, startMs, lastMs } = current;
  current = null;
  if (lastMs - startMs < 1000) return;
  queue.push({ id, app, exeName, title, startedAt, endedAt: new Date(lastMs).toISOString() });
  void persist();
}

function tick() {
  const now = Date.now();
  const slept = lastTickMs && now - lastTickMs > GAP_MS;
  lastTickMs = now;
  if (slept) close();

  const locked = powerMonitor.getSystemIdleState(1) === 'locked';
  const fg = !locked && latest ? describe(latest) : null;

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
    const [exePath = '', title = ''] = line.split('\t');
    latest = { exePath: exePath.trim(), title: title.trim() };
  });
  child.on('exit', () => {
    if (watcher !== child) return;
    latest = null;
    // Killed or crashed while tracking: start it again.
    restartTimer = setTimeout(spawnWatcher, RESTART_DELAY_MS);
  });
}

export async function startScreenTime() {
  if (process.platform !== 'win32' || watcher) return;
  queue = (await readJson<ScreenTimeSession[]>(QUEUE_FILE)) ?? [];
  spawnWatcher();

  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('lock-screen', onSuspend);
  timer = setInterval(tick, TICK_MS);
}

function onSuspend() {
  close();
}

export async function stopScreenTime({ clear = false } = {}) {
  clearInterval(timer);
  clearTimeout(restartTimer);
  powerMonitor.off('suspend', onSuspend);
  powerMonitor.off('lock-screen', onSuspend);
  const child = watcher;
  watcher = null;
  child?.kill();
  close();
  if (clear) {
    queue = [];
    await removeJson(QUEUE_FILE);
  }
}

// Sessions to send with the next sync (oldest first, API accepts 2000 per call).
export const pendingScreenTime = () => queue.slice(0, 2000);

export async function acknowledgeScreenTime(ids: string[]) {
  const sent = new Set(ids);
  queue = queue.filter((s) => !sent.has(s.id));
  await persist();
}
