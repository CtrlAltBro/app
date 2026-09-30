import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { isProtected } from '../core/protected';
import { readJson, writeJson } from '../core/storage';

const run = promisify(execFile);

// Once a limit is reached, stop the app from being started again until midnight,
// so the child cannot reopen it (even by killing the session app). Uses Image File
// Execution Options: Windows runs the "Debugger" program instead of the target, so
// pointing it at our own app means the limited app simply never launches. The block
// is removed at local midnight, on a parent reset, or when the rule goes away.
//
// IFEO is machine-wide and by image name, so we never touch a protected/system exe,
// and we only ever remove keys we set ourselves (tracked in blocked.json). It also
// catches the parent: while an account we don't monitor has a session open, the
// keys are lifted (pauseLaunchBlocks) and the child is held by the kill on sight
// alone. The stub can't simply start the parent's app instead, as the relaunched
// helper processes of a multi-process app (Edge…) lose what their parent handed them.

const IFEO = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options';
const STATE_FILE = 'blocked.json';
// What Windows launches in place of a blocked app: our own session app, as a stub
// (src/main/blocked-launch.ts) that shows the blocked screen to a monitored account
// and starts the real exe for anyone else (the few seconds before a parent's new
// session lifts the keys). A GUI app, so no console flashes.
const blocker = () => path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'CtrlAltBro', 'app', 'ctrlaltbro.exe');

type State = { day: string; exes: string[] };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const loadState = async (): Promise<State> => (await readJson<State>(STATE_FILE)) ?? { day: today(), exes: [] };
const saveState = (s: State) => writeJson(STATE_FILE, s);

const keyFor = (exeName: string) => `${IFEO}\\${exeName}`;

// The current Debugger value for an image, or null if none.
async function currentDebugger(exeName: string): Promise<string | null> {
  try {
    const { stdout } = await run('reg.exe', ['query', keyFor(exeName), '/v', 'Debugger'], { windowsHide: true });
    return /Debugger\s+REG_SZ\s+(.+)/i.exec(stdout)?.[1]?.trim() ?? null;
  } catch {
    return null; // key or value absent
  }
}

// True while a parent session is open: blocks are tracked but their keys are lifted.
let paused = false;

// Point the image's Debugger at our stub, unless someone else set one (e.g. a real
// debugging session). Returns false when it left the image alone.
async function setKey(exe: string): Promise<boolean> {
  const existing = await currentDebugger(exe);
  const ours = blocker();
  if (existing && existing.replace(/^"|"$/g, '').toLowerCase() !== ours.toLowerCase()) {
    console.warn(`[ifeo] ${exe} a déjà un Debugger tiers, je n'y touche pas`);
    return false;
  }
  await run('reg.exe', ['add', keyFor(exe), '/v', 'Debugger', '/t', 'REG_SZ', '/d', `"${ours}"`, '/f'], { windowsHide: true });
  return true;
}

// Stop `exeName` from launching (idempotent). Refuses protected/system exes.
// Note: IFEO catches classic Win32 exes (browsers, games, most apps) but NOT
// Store/UWP apps (their activation bypasses it); those are still held down by the
// fallback kill-on-sight, just not prevented from relaunching (AppLocker later).
export async function blockLaunch(exeName: string) {
  const exe = exeName.toLowerCase();
  if (isProtected(exe)) return;
  const state = await loadState();
  if (state.exes.includes(exe)) return; // already ours
  if (!paused && !(await setKey(exe))) return;
  await saveState({ day: today(), exes: [...state.exes, exe] });
  console.log(`[ifeo] 🚫 ${exe} bloqué au lancement jusqu'à minuit${paused ? ' (dès que la session parent sera fermée)' : ''}`);
}

// Lift our keys while an unmonitored (parent) session is open, put them back once
// it is closed. Called often by the service; only acts on a change.
export async function pauseLaunchBlocks(pause: boolean) {
  if (pause === paused) return;
  paused = pause;
  const { exes } = await loadState();
  for (const exe of exes) await (pause ? unblock(exe) : setKey(exe));
  if (exes.length) {
    console.log(
      pause
        ? `[ifeo] ⏸️  session parent ouverte → ${exes.length} blocage(s) au lancement suspendu(s)`
        : `[ifeo] ▶️  plus de session parent → ${exes.length} blocage(s) au lancement remis`,
    );
  }
}

// Remove the block on one image: delete our Debugger value, and the image's IFEO
// key too when it is left empty (we created it), so nothing is left behind.
async function unblock(exe: string) {
  await run('reg.exe', ['delete', keyFor(exe), '/v', 'Debugger', '/f'], { windowsHide: true }).catch(() => undefined);
  // Delete the key only if it now has no values and no subkeys.
  const { stdout } = await run('reg.exe', ['query', keyFor(exe)], { windowsHide: true }).catch(() => ({ stdout: '' }));
  const empty = !stdout.split(/\r?\n/).some((l) => /REG_|\\Image File Execution Options\\.+\\/i.test(l));
  if (empty) await run('reg.exe', ['delete', keyFor(exe), '/f'], { windowsHide: true }).catch(() => undefined);
}

export const blockedExes = async () => (await loadState()).exes;

// Allow `exeName` to launch again (only removes a block we set).
export async function allowLaunch(exeName: string) {
  const exe = exeName.toLowerCase();
  const state = await loadState();
  if (!state.exes.includes(exe)) return;
  await unblock(exe);
  await saveState({ ...state, exes: state.exes.filter((e) => e !== exe) });
  console.log(`[ifeo] ✅ ${exe} de nouveau autorisé`);
}

// Every IFEO image whose Debugger points at our blocker, found by scanning the
// registry — so we also catch orphans that blocked.json doesn't track (e.g. keys
// left by a previous install/pairing, like a stuck devenv.exe).
async function ourBlockedExes(): Promise<string[]> {
  const ours = blocker().toLowerCase();
  const { stdout } = await run('reg.exe', ['query', IFEO, '/s', '/v', 'Debugger'], { windowsHide: true }).catch(
    () => ({ stdout: '' }),
  );
  const exes: string[] = [];
  let currentExe: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const key = /Image File Execution Options\\([^\\]+)\s*$/i.exec(line);
    if (key) { currentExe = key[1].toLowerCase(); continue; }
    const dbg = /Debugger\s+REG_SZ\s+(.+)/i.exec(line);
    if (dbg && currentExe) {
      const val = dbg[1].trim().replace(/^"|"$/g, '').toLowerCase();
      if (val === ours || val.includes('ctrlaltbro')) exes.push(currentExe);
      currentExe = null;
    }
  }
  return exes;
}

// Remove every block we set (local midnight, a clean start, or a recalibration).
// Scans the registry as well as blocked.json, so orphaned keys are cleaned too.
export async function allowAll() {
  const exes = new Set([...(await loadState()).exes, ...(await ourBlockedExes())]);
  for (const exe of exes) await unblock(exe);
  if (exes.size) console.log(`[ifeo] ✅ ${exes.size} blocage(s) levé(s)`);
  await saveState({ day: today(), exes: [] });
}

// At startup: clear blocks left over from a previous day (the service may have been
// off across midnight), so limits never carry over.
export async function clearStaleBlocks() {
  const state = await loadState();
  if (state.exes.length && state.day !== today()) await allowAll();
}
