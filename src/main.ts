import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { initAgent, shutdownAgent } from './core/agent';
import { installElectronHost } from './main/electron-host';
import { registerAgentIpc } from './main/ipc';

if (started) {
  app.quit();
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    title: 'CtrlAltBro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Windows shutdown, restart or log off: best effort, Windows may not wait for the upload.
  mainWindow.on('session-end', () => void shutdownAgent());
};

// Upload pending screen time before quitting (bounded by a short timeout).
let quitReady = false;
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  void shutdownAgent().finally(() => {
    quitReady = true;
    app.quit();
  });
});


app.on('ready', async () => {
  installElectronHost();
  registerAgentIpc();
  await initAgent();
  createWindow();
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
