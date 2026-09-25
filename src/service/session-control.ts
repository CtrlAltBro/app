import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Reaching the child's desktop from the service (session 0) without the session app:
// a message box via msg.exe, or locking by disconnecting the session with tsdiscon.

// The session id of a signed-in account, or null if it is not logged on.
export async function sessionIdForUser(user: string): Promise<number | null> {
  // `query user <name>` prints a header then the user's row; the ID is a number column.
  const { stdout } = await run('query.exe', ['user', user], { windowsHide: true }).catch(() => ({ stdout: '' }));
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    // e.g. " child   console   1   Active ..."  (a leading ">" marks the current session)
    const m = /^[>\s]*\S+\s+\S*\s+(\d+)\s/.exec(line) ?? /^[>\s]*\S+\s+(\d+)\s/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

// Show a plain message box on the account's desktop (Windows Pro+). Best effort.
export async function messageUser(user: string, text: string): Promise<boolean> {
  try {
    await run('msg.exe', [user, '/TIME:86400', text], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Send the account's session back to the lock/sign-in screen (disconnect it).
export async function lockUserSession(user: string): Promise<boolean> {
  const id = await sessionIdForUser(user);
  if (id == null) return false;
  try {
    await run('tsdiscon.exe', [String(id)], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
