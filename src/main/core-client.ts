import { execFile } from 'node:child_process';
import net from 'node:net';
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

export async function pair(code: string, name: string): Promise<PairResult> {
  if (!core) return { ok: false, error: 'Le service CtrlAltBro ne répond pas.' };
  return core.request('pair', { code, name }).catch(() => ({ ok: false, error: 'Le service CtrlAltBro ne répond pas.' }));
}

// App quit or Windows session end: hand the running session to the core.
export async function closeSession() {
  saveCurrentSession();
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  await Promise.race([core?.flushed(), timeout]);
}
