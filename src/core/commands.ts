import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command, CommandResult } from '../shared/api-types';
import { host } from './host';
import { isProtected } from './protected';

const run = promisify(execFile);

// taskkill exit code when no process matches the image name.
const TASKKILL_NOT_FOUND = 128;

// Closes every process with this image name (and its child processes).
export async function killApp(exeName: string): Promise<'killed' | 'not-running' | 'protected'> {
  if (isProtected(exeName)) return 'protected';
  try {
    await run('taskkill.exe', ['/IM', exeName, '/F', '/T'], { windowsHide: true });
    return 'killed';
  } catch (e) {
    if ((e as { code?: number }).code === TASKKILL_NOT_FOUND) return 'not-running';
    throw e;
  }
}

export async function executeCommand(command: Command): Promise<CommandResult> {
  const done = (): CommandResult => ({ id: command.id, status: 'done' });
  const failed = (error: string): CommandResult => ({ id: command.id, status: 'failed', error });

  if (command.type === 'show_message') {
    host().ui.message(command.payload.text);
    return done();
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
        await run('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true });
        return done();
      default:
        return failed(`Commande inconnue « ${(command as { type: string }).type} »`);
    }
  } catch (e) {
    return failed(((e as { stderr?: string }).stderr || (e as Error).message).trim().slice(0, 1000));
  }
}
