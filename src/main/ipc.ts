import { ipcMain } from 'electron';
import { getSettings, getStatus, pair, saveSettings } from './core-client';

const SID = /^S-1-5-21-[0-9-]+$/i;

export function registerAgentIpc() {
  ipcMain.handle('agent:getStatus', () => getStatus());

  ipcMain.handle('agent:pair', (_event, code: unknown, name: unknown) => {
    if (typeof code !== 'string' || typeof name !== 'string') {
      return { ok: false, error: 'Requête invalide.' };
    }
    return pair(code, name);
  });

  ipcMain.handle('agent:getSettings', () => getSettings());

  ipcMain.handle('agent:saveSettings', (_event, apiUrl: unknown, sids: unknown) => {
    if (typeof apiUrl !== 'string' || apiUrl.length > 500 || !/^https?:\/\/\S+$/i.test(apiUrl.trim())) {
      return { ok: false, error: 'Adresse du serveur invalide (ex. https://ctrlaltbro.exemple.fr).' };
    }
    if (!Array.isArray(sids) || !sids.length || sids.length > 50 || !sids.every((s) => typeof s === 'string' && SID.test(s))) {
      return { ok: false, error: 'Coche au moins un compte à surveiller.' };
    }
    return saveSettings(apiUrl.trim(), sids as string[]);
  });
}
