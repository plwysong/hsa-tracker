// One-piece desktop app: runs the server inside this process and shows the
// dashboard in its own window. Closing the window quits everything.
import { app, BrowserWindow, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = 'http://localhost:8321';

// Clicking the icon while the app is already open focuses the existing window
// instead of starting a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Chromium registers as a system media player by default (for keyboard
// play/pause keys), which makes macOS show an "access Apple Music" permission
// prompt. This app plays no media — turn it off so the prompt never appears.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

// The window IS the lifecycle here — the browser-mode idle auto-exit would fight it.
process.env.HSA_NO_AUTOEXIT = '1';

// Packaged app: the .app bundle is read-only, so data lives in the standard
// per-user location (~/Library/Application Support/HSA Tracker/data). The path
// is spelled out explicitly — Electron's userData naming varies between the
// package name and product name depending on how the app is launched. Running
// from the project folder keeps using hsa-tracker/data as before.
if (app.isPackaged && !process.env.HSA_DATA_DIR) {
  process.env.HSA_DATA_DIR = path.join(app.getPath('appData'), 'HSA Tracker', 'data');
}

await import('./server.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 720,
    minHeight: 500,
    title: 'HSA Tracker',
    backgroundColor: '#f9f9f7',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(URL);
  // Receipt views open in their own window (Chromium's built-in PDF viewer);
  // anything external — download links, API-key signup pages — opens in the
  // user's real browser instead of a bare Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
