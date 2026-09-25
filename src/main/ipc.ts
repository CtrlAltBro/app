import { ipcMain } from 'electron';
import { getStatus, pair } from './core-client';

export function registerAgentIpc() {
  ipcMain.handle('agent:getStatus', () => getStatus());

  ipcMain.handle('agent:pair', (_event, code: unknown, name: unknown) => {
    if (typeof code !== 'string' || typeof name !== 'string') {
      return { ok: false, error: 'Requête invalide.' };
    }
    return pair(code, name);
  });
}
