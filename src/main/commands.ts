import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dialog } from 'electron';
import type { Command, CommandResult } from '../shared/api-types';
import { isProtected } from './protected';

const run = promisify(execFile);

// taskkill exit code when no process matches the image name.
const TASKKILL_NOT_FOUND = 128;

export async function executeCommand(command: Command): Promise<CommandResult> {
  const done = (): CommandResult => ({ id: command.id, status: 'done' });
  const failed = (error: string): CommandResult => ({ id: command.id, status: 'failed', error });

  if (command.type === 'show_message') {
    void dialog.showMessageBox({ type: 'info', title: 'CtrlAltBro', message: command.payload.text });
    return done();
  }

  if (process.platform !== 'win32') return failed(`« ${command.type} » n'est pas supporté sur ${process.platform}`);

  try {
    switch (command.type) {
      case 'kill_app': {
        const { exeName } = command.payload;
        if (isProtected(exeName)) return failed(`${exeName} est protégé et ne peut pas être fermé`);
        try {
          await run('taskkill.exe', ['/IM', exeName, '/F', '/T'], { windowsHide: true });
        } catch (e) {
          if ((e as { code?: number }).code === TASKKILL_NOT_FOUND) return failed(`${exeName} n'est pas lancé`);
          throw e;
        }
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
