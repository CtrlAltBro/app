import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command, CommandResult } from '../shared/api-types';
import { host } from './host';
import { isProtected } from './protected';

const run = promisify(execFile);

// taskkill exit code when no process matches the image name.
const TASKKILL_NOT_FOUND = 128;

// Closes every process with this image name (and its child processes). With
// ownerUser, only that account's processes are closed — so a limit on the child
// never kills the same app in the parent's session (taskkill /FI "USERNAME eq …").
export async function killApp(
  exeName: string,
  opts: { ownerUser?: string } = {},
): Promise<'killed' | 'not-running' | 'protected'> {
  if (isProtected(exeName)) return 'protected';
  const args = ['/IM', exeName, '/F', '/T'];
  if (opts.ownerUser) args.push('/FI', `USERNAME eq ${opts.ownerUser}`);
  try {
    const { stdout } = await run('taskkill.exe', args, { windowsHide: true });
    // With a filter that matches nothing taskkill still exits 0 but kills nothing.
    return /SUCCESS/i.test(stdout) ? 'killed' : 'not-running';
  } catch (e) {
    if ((e as { code?: number }).code === TASKKILL_NOT_FOUND) return 'not-running';
    throw e;
  }
}

export async function executeCommand(command: Command): Promise<CommandResult> {
  const done = (): CommandResult => ({ id: command.id, status: 'done' });
  const failed = (error: string): CommandResult => ({ id: command.id, status: 'failed', error });

  if (command.type === 'show_message') {
    try {
      await host().ui.message(command.payload.text);
      return done();
    } catch (e) {
      return failed((e as Error).message);
    }
  }

  if (process.platform !== 'win32') return failed(`« ${command.type} » n'est pas supporté sur ${process.platform}`);

  try {
    switch (command.type) {
      case 'kill_app': {
        const { exeName } = command.payload;
        const outcome = await killApp(exeName);
        if (outcome === 'protected') return failed(`${exeName} est protégé et ne peut pas être fermé`);
        if (outcome === 'not-running') return failed(`${exeName} n'est pas lancé`);
        return done();
      }
      case 'lock_session':
        await host().ui.lockSession();
        return done();
      default:
        return failed(`Commande inconnue « ${(command as { type: string }).type} »`);
    }
  } catch (e) {
    return failed(((e as { stderr?: string }).stderr || (e as Error).message).trim().slice(0, 1000));
  }
}
