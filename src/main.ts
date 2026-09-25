import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { closeSession, connectCore } from './main/core-client';
import { registerAgentIpc } from './main/ipc';
import { TRAY_ICON_PNG } from './main/tray-icon';

// One instance only: a second launch just reveals the existing window. The service
// relies on this so relaunching the app never spawns a duplicate.
if (!app.requestSingleInstanceLock() || started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// The window is only really closed when we are quitting; otherwise it hides to the tray.
let quitting = false;

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.setSkipTaskbar(false);
  mainWindow.focus();
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
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
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // The child cannot close the app: the close button hides it to the tray instead.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
    mainWindow?.setSkipTaskbar(true);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Windows shutdown, restart or log off: hand the running screen-time session to the core.
  mainWindow.on('session-end', () => void closeSession());
};

function createTray() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG}`);
  tray = new Tray(icon);
  tray.setToolTip('CtrlAltBro');
  const items: Electron.MenuItemConstructorOptions[] = [{ label: 'Ouvrir CtrlAltBro', click: showWindow }];
  // No "Quitter" for the child in production; a dev-only escape hatch while testing.
  if (!app.isPackaged) {
    items.push({ type: 'separator' }, { label: 'Quitter (dev)', click: () => app.quit() });
  }
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.on('click', showWindow);
}

// Hand the running screen-time session to the core before quitting.
let quitReady = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (quitReady) return;
  event.preventDefault();
  void closeSession().finally(() => {
    quitReady = true;
    app.quit();
  });
});

app.on('second-instance', showWindow);

app.on('ready', () => {
  registerAgentIpc();
  connectCore();
  createTray();
  createWindow();
});

// Stay alive in the tray when the window is closed/hidden; the service owns our lifecycle.
app.on('window-all-closed', () => undefined);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
