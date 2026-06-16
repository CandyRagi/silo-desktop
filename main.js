// ═══════════════════════════════════════════════════════════
// Silo Desktop — Electron Main Process
// ═══════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const os   = require('os');

const DiscoveryService = require('./src/discovery');
const TransferManager  = require('./src/transfer');
const { mouse, left, right, Point, keyboard, Key } = require('@nut-tree-fork/nut-js');

let mainWindow    = null;
let discovery     = null;
let transferMgr   = null;

// ── Window ─────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1100,
    height:          720,
    minWidth:        800,
    minHeight:       560,
    frame:           false,
    icon:            path.join(__dirname, 'icon.png'),
    titleBarStyle:   'hidden',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Services ───────────────────────────────────────────────

function initServices() {
  discovery   = new DiscoveryService();
  transferMgr = new TransferManager();

  // Forward discovery events to renderer
  discovery.on('device-found', (device) => {
    mainWindow?.webContents.send('device-found', device);
  });
  discovery.on('device-updated', (device) => {
    mainWindow?.webContents.send('device-updated', device);
  });
  discovery.on('scan-timeout', () => {
    mainWindow?.webContents.send('scan-timeout');
  });

  // Forward transfer events to renderer
  transferMgr.on('device-connected', (info) => {
    discovery.markConnected(info.ip, info.sessionId);
    mainWindow?.webContents.send('device-connected', info);
  });
  transferMgr.on('device-disconnected', (info) => {
    // Find IP for this session and mark disconnected
    for (const dev of discovery.getDevices()) {
      if (dev.sessionId === info.sessionId) discovery.markDisconnected(dev.ip);
    }
    mainWindow?.webContents.send('device-disconnected', info);
  });
  transferMgr.on('transfer-incoming', (info) => {
    mainWindow?.webContents.send('transfer-incoming', info);
  });
  transferMgr.on('transfer-progress', (info) => {
    mainWindow?.webContents.send('transfer-progress', info);
  });
  transferMgr.on('transfer-complete', (info) => {
    mainWindow?.webContents.send('transfer-complete', info);
  });
  transferMgr.on('transfer-cancelled', (info) => {
    mainWindow?.webContents.send('transfer-cancelled', info);
  });

  // Mouse Control Events
  transferMgr.on('mouse-move', async (info) => {
    if (!transferMgr.allowControl) return;
    try {
      // nut-js moves mouse relative to current position, or we calculate absolute
      // The phone sends dx/dy as floats. Multiply by a sensitivity factor if needed.
      const current = await mouse.getPosition();
      // Increase sensitivity to make the trackpad feel natural
      const sensitivity = 2.0;
      await mouse.setPosition(new Point(current.x + info.dx * sensitivity, current.y + info.dy * sensitivity));
    } catch (err) {
      console.warn('[Mouse] Move error:', err);
    }
  });

  transferMgr.on('mouse-click', async (info) => {
    if (!transferMgr.allowControl) return;
    try {
      if (info.button === 'left') {
        await mouse.leftClick();
      } else if (info.button === 'right') {
        await mouse.rightClick();
      }
    } catch (err) {
      console.warn('[Mouse] Click error:', err);
    }
  });

  // Keyboard Control Events
  transferMgr.on('keyboard-input', async (info) => {
    if (!transferMgr.allowControl) return;
    try {
      if (info.key === 'BACKSPACE') {
        await keyboard.type(Key.Backspace);
      } else if (info.key === 'ENTER') {
        await keyboard.type(Key.Return);
      } else {
        await keyboard.type(info.key);
      }
    } catch (err) {
      console.warn('[Keyboard] Input error:', err);
    }
  });

  transferMgr.start();
}

// ── IPC Handlers ───────────────────────────────────────────

function registerIPC() {

  // Discovery
  ipcMain.handle('start-discovery', () => {
    discovery.start();
    return { ok: true };
  });

  ipcMain.handle('stop-discovery', () => {
    discovery.stop();
    return { ok: true };
  });

  ipcMain.handle('get-devices', () => {
    return discovery.getDevices();
  });

  ipcMain.handle('forget-device', (_event, ip) => {
    discovery.knownDevices.delete(ip);
    return { ok: true };
  });

  // Pairing
  ipcMain.handle('connect-device', async (_event, { ip, port, pin }) => {
    try {
      const sessionId = await transferMgr.pairDevice(ip, port, os.hostname(), pin);
      return { ok: true, sessionId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('disconnect-device', (_event, { sessionId }) => {
    transferMgr.disconnectSession(sessionId);
    return { ok: true };
  });

  // File sending
  ipcMain.handle('send-file', async (_event, { filePath, sessionId }) => {
    try {
      await transferMgr.sendFile(filePath, sessionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // File picker dialog
  ipcMain.handle('pick-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Select files to send',
    });
    return result.canceled ? [] : result.filePaths;
  });

  // Save directory
  ipcMain.handle('get-save-dir', () => transferMgr.getSaveDir());

  ipcMain.handle('set-save-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (!canceled && filePaths.length > 0) {
      transferMgr.setSaveDir(filePaths[0]);
    }
    return transferMgr.getSaveDir();
  });

  // Open saved file location
  ipcMain.handle('open-save-dir', async () => {
    await shell.openPath(transferMgr.getSaveDir());
  });

  ipcMain.handle('set-allow-control', (e, allow) => {
    transferMgr.setAllowControl(allow);
  });

  ipcMain.handle('reveal-file', async (e, { filePath }) => {
    shell.showItemInFolder(filePath);
  });

  // Window controls (frameless)
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window-close', () => mainWindow?.close());

  // App info
  ipcMain.handle('get-hostname', () => os.hostname());
  ipcMain.handle('get-local-ip', () => discovery?._getLocalIP() ?? '—');
}

// ── App Lifecycle ──────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  initServices();
  registerIPC();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  discovery?.stop();
  transferMgr?.stop();
  // Delay app.quit() to allow UDP DISCONNECT packets to reach the network interface
  setTimeout(() => {
    if (process.platform !== 'darwin') app.quit();
  }, 100);
});
