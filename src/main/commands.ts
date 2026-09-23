import { dialog } from 'electron';
import type { Command, CommandResult } from '../shared/api-types';

export async function executeCommand(command: Command): Promise<CommandResult> {
  switch (command.type) {
    case 'show_message':
      void dialog.showMessageBox({ type: 'info', title: 'CtrlAltBro', message: command.payload.text });
      return { id: command.id, status: 'done' };
    default:
      return {
        id: command.id,
        status: 'failed',
        error: `"${command.type}" is not supported on ${process.platform} yet`,
      };
  }
}
