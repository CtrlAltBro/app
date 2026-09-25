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
// and we only ever remove keys we set ourselves (tracked in blocked.json).

const IFEO = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options';
const STATE_FILE = 'blocked.json';
// What Windows launches in place of a blocked app: our own session app, which just
// shows its window (single-instance) and never starts the target. A GUI app, so no
// console flashes.
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

// Stop `exeName` from launching (idempotent). Refuses protected/system exes and
// won't overwrite a Debugger someone else set (e.g. a real debugging session).
// Note: IFEO catches classic Win32 exes (browsers, games, most apps) but NOT
// Store/UWP apps (their activation bypasses it); those are still held down by the
// fallback kill-on-sight, just not prevented from relaunching (AppLocker later).
export async function blockLaunch(exeName: string) {
  const exe = exeName.toLowerCase();
  if (isProtected(exe)) return;
  const state = await loadState();
  if (state.exes.includes(exe)) return; // already ours

  const existing = await currentDebugger(exe);
  const ours = blocker();
  if (existing && existing.replace(/^"|"$/g, '').toLowerCase() !== ours.toLowerCase()) {
    console.warn(`[ifeo] ${exe} a déjà un Debugger tiers, je n'y touche pas`);
    return;
  }
  await run('reg.exe', ['add', keyFor(exe), '/v', 'Debugger', '/t', 'REG_SZ', '/d', `"${ours}"`, '/f'], { windowsHide: true });
  await saveState({ day: today(), exes: [...state.exes, exe] });
  console.log(`[ifeo] 🚫 ${exe} bloqué au lancement jusqu'à minuit`);
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

// Allow `exeName` to launch again (only removes a block we set).
export async function allowLaunch(exeName: string) {
  const exe = exeName.toLowerCase();
  const state = await loadState();
  if (!state.exes.includes(exe)) return;
  await unblock(exe);
  await saveState({ ...state, exes: state.exes.filter((e) => e !== exe) });
  console.log(`[ifeo] ✅ ${exe} de nouveau autorisé`);
}

// Remove every block we set (local midnight, or a clean start).
export async function allowAll() {
  const state = await loadState();
  for (const exe of state.exes) await unblock(exe);
  if (state.exes.length) console.log(`[ifeo] ✅ ${state.exes.length} blocage(s) levé(s)`);
  await saveState({ day: today(), exes: [] });
}

// At startup: clear blocks left over from a previous day (the service may have been
// off across midnight), so limits never carry over.
export async function clearStaleBlocks() {
  const state = await loadState();
  if (state.exes.length && state.day !== today()) await allowAll();
}
