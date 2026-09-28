import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserWindow, dialog } from 'electron';
import type { AgentStatus, PairResult } from '../shared/agent-api';
import type { ScreenTimeSession } from '../shared/api-types';
import { PIPE_PATH, PipeConnection, type CoreApi, type SessionApi } from '../shared/pipe';
import { saveCurrentSession, startScreenTime, stopScreenTime } from './screen-time';
import { showTimeUp, snapshotForeground, type Snapshot } from './time-up';

const run = promisify(execFile);

// SID of the account this app runs as, resolved once. Lets the core tell the
// child's session apart from the parent's.
let sidPromise: Promise<string | null> | undefined;
function ownSid() {
  sidPromise ??= run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);
  return sidPromise;
}

// The session app talks to the core (service) over the named pipe: it shows the
// status, forwards what the foreground sensor sees, and does the UI the core asks for.

type Core = PipeConnection<SessionApi, CoreApi>;

const RETRY_MS = 2_000;
// Sessions finished while the core is unreachable, sent once it is back.
const MAX_BACKLOG = 500;

let core: Core | null = null;
let loggedDown = false;
let status: AgentStatus | null = null;
let snapshot: Snapshot | null = null;
let sensing = false;
const backlog: ScreenTimeSession[] = [];
let connected: Promise<Core>;
let resolveConnected: (core: Core) => void;

function waitForCore() {
  connected = new Promise((resolve) => (resolveConnected = resolve));
}
waitForCore();

function setStatus(next: AgentStatus) {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('agent:status', next);
  // Screen time is only measured while paired.
  if (next.paired && !sensing) {
    sensing = true;
    startScreenTime({
      session: (session) => {
        if (core) core.emit('session', session);
        else if (backlog.push(session) > MAX_BACKLOG) backlog.shift();
      },
      foreground: (exeName, elapsedMs) => core?.emit('foreground', { exeName, elapsedMs }),
      leave: () => core?.emit('leave'),
    });
  } else if (!next.paired && sensing) {
    sensing = false;
    stopScreenTime({ discard: true });
  }
}

function connect() {
  const socket = net.connect(PIPE_PATH);
  socket.once('connect', () => {
    const conn: Core = new PipeConnection(socket);
    conn
      .on('status', setStatus)
      .handle('message', ({ text }) => {
        void dialog.showMessageBox({ type: 'info', title: 'CtrlAltBro', message: text });
      })
      .on('timeUp', (text) => {
        showTimeUp(snapshot, text);
        snapshot = null;
      })
      .handle('lock', async () => {
        // Lock this (the child's) desktop.
        await run('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true });
      })
      .handle('snapshotForeground', async () => {
        snapshot = await snapshotForeground().catch(() => null);
      })
      .handle('saveCurrentSession', () => saveCurrentSession());
    core = conn;
    loggedDown = false;
    console.log('[pipe] 🔌 connecté au cœur');
    // Tell the core which account we run as, so it can tell the child from the parent.
    void ownSid().then((sid) => sid && conn === core && conn.emit('hello', { sid }));
    for (const session of backlog.splice(0)) conn.emit('session', session);
    resolveConnected(conn);
    conn.request('getStatus').then(setStatus, () => undefined);
  });
  socket.once('close', () => {
    if (core?.socket === socket) {
      core = null;
      waitForCore();
      console.log('[pipe] 💤 cœur injoignable, nouvel essai…');
      if (status?.paired) setStatus({ ...status, sync: { ...status.sync, error: 'Service CtrlAltBro arrêté' } });
    } else if (!loggedDown) {
      // Never connected yet: log the first failure (then stay quiet while retrying).
      loggedDown = true;
      console.log('[pipe] ⏳ service CtrlAltBro pas encore joignable, nouvel essai toutes les 2 s…');
    }
    setTimeout(connect, RETRY_MS);
  });
  socket.on('error', (err) => {
    if (!core && !loggedDown) console.log('[pipe] ⏳ connexion au service échouée:', (err as Error).message);
  });
}

export function connectCore() {
  connect();
}

export async function getStatus(): Promise<AgentStatus> {
  if (status) return status;
  return (await connected).request('getStatus');
}

// Pairing is an admin action (the service refuses it over the pipe, so a child
// cannot pair the PC to their own account). The button raises a UAC prompt: an
// elevated helper pairs as admin, then restarts the service so it reloads the
// token. A standard user cannot elevate, so this stays admin-only.
export async function pair(code: string, name: string): Promise<PairResult> {
  const elevated = await runElevatedPairing(code, name);
  if (!elevated.ok) return { ok: false, error: elevated.error ?? "Échec de l'appairage." };
  // The service was restarted; the pipe reconnects and pushes the paired status.
  const paired = await waitForPaired(12_000);
  return { ok: true, status: paired ?? status ?? { paired: false, suggestedName: name } };
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function runElevatedPairing(code: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const dir = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'CtrlAltBro');
  const node = path.join(dir, 'node.exe');
  const js = path.join(dir, 'service.js');
  // Runs elevated: pair as admin, then restart the service so it reloads the token.
  const inner =
    `& ${psQuote(node)} ${psQuote(js)} pair ${psQuote(code)} ${psQuote(name)}; ` +
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Restart-Service CtrlAltBro`;
  // -Verb RunAs raises the UAC prompt; on decline it throws (mapped to 1223).
  // -WindowStyle Hidden keeps the elevated helper's console from flashing on screen.
  const outer =
    `try { $p = Start-Process powershell -Verb RunAs -Wait -PassThru ` +
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-Command', ${psQuote(inner)}); exit $p.ExitCode } ` +
    `catch { exit 1223 }`;
  try {
    await run('powershell.exe', ['-NoProfile', '-Command', outer], { windowsHide: true });
    return { ok: true };
  } catch (err) {
    const exit = (err as { code?: number | string }).code;
    if (exit === 1223) return { ok: false, error: 'Appairage annulé (autorisation administrateur refusée).' };
    return { ok: false, error: "Échec de l'appairage. Vérifie le code, puis réessaie (une autorisation administrateur est requise)." };
  }
}

// Poll the last pushed status until the PC shows as paired, or give up.
function waitForPaired(timeoutMs: number): Promise<Extract<AgentStatus, { paired: true }> | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const s = status;
      if (s?.paired) return resolve(s);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 300);
    };
    tick();
  });
}

// App quit or Windows session end: hand the running session to the core.
export async function closeSession() {
  saveCurrentSession();
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  await Promise.race([core?.flushed(), timeout]);
}
