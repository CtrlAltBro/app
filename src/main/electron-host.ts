import { app, BrowserWindow, dialog, powerMonitor, safeStorage, shell } from 'electron';
import { flushNow, syncNow } from '../core/agent';
import { setHost } from '../core/host';
import { foregroundTick } from '../core/limits';
import { addSession } from '../core/screen-time-queue';
import { saveCurrentSession, startScreenTime, stopScreenTime } from './screen-time';
import { showTimeUp, snapshotForeground, type Snapshot } from './time-up';

// The Electron main process hosts the core (milestone 1 of the service split):
// it provides what the core needs and wires the foreground sensor to it.

let snapshot: Snapshot | null = null;
let sensing = false;

export function installElectronHost() {
  setHost({
    version: app.getVersion(),
    isDev: !app.isPackaged,
    dataDir: app.getPath('userData'),
    secrets: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
    },
    readShortcut: (file) => shell.readShortcutLink(file),
    statusChanged(status) {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('agent:status', status);
      // Screen time is only measured while paired.
      if (status.paired && !sensing) {
        sensing = true;
        startScreenTime({ session: addSession, foreground: foregroundTick, leave: flushNow });
      } else if (!status.paired && sensing) {
        sensing = false;
        stopScreenTime({ discard: true });
      }
    },
    ui: {
      message(text) {
        void dialog.showMessageBox({ type: 'info', title: 'CtrlAltBro', message: text });
      },
      async snapshotForeground() {
        snapshot = await snapshotForeground().catch(() => null);
      },
      showTimeUp(text) {
        showTimeUp(snapshot, text);
        snapshot = null;
      },
      async saveCurrentSession() {
        saveCurrentSession();
      },
    },
  });

  powerMonitor.on('resume', syncNow);
}
