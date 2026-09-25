import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { closeSession, connectCore } from './main/core-client';
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

  // Windows shutdown, restart or log off: hand the running screen-time session to the core.
  mainWindow.on('session-end', () => void closeSession());
};

// Hand the running screen-time session to the core before quitting.
let quitReady = false;
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  void closeSession().finally(() => {
    quitReady = true;
    app.quit();
  });
});


app.on('ready', () => {
  registerAgentIpc();
  connectCore();
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
