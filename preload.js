// ═══════════════════════════════════════════════════════════
// Silo Desktop — Preload (Context Bridge)
// Exposes a safe siloAPI to the renderer process.
// ═══════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siloAPI', {
  // ── Discovery ─────────────────────────────────────────────
  startDiscovery:  ()          => ipcRenderer.invoke('start-discovery'),
  stopDiscovery:   ()          => ipcRenderer.invoke('stop-discovery'),
  getDevices:      ()          => ipcRenderer.invoke('get-devices'),
  forgetDevice:    (ip)        => ipcRenderer.invoke('forget-device', ip),

  // ── Pairing ───────────────────────────────────────────────
  connectDevice:   (args)      => ipcRenderer.invoke('connect-device', args),
  disconnectDevice:(args)      => ipcRenderer.invoke('disconnect-device', args),

  // ── File Transfer ─────────────────────────────────────────
  sendFile:        (args)      => ipcRenderer.invoke('send-file', args),
  pickFiles:       ()          => ipcRenderer.invoke('pick-files'),

  // ── Settings ──────────────────────────────────────────────
  getSaveDir:      ()          => ipcRenderer.invoke('get-save-dir'),
  setSaveDir:      ()          => ipcRenderer.invoke('set-save-dir'),
  openSaveDir:     ()          => ipcRenderer.invoke('open-save-dir'),
  setAllowControl: (allow)     => ipcRenderer.invoke('set-allow-control', allow),
  revealFile:      (args)      => ipcRenderer.invoke('reveal-file', args),
  getHistory:      ()          => ipcRenderer.invoke('get-history'),
  clearHistory:    ()          => ipcRenderer.invoke('clear-history'),
  getHostname:     ()          => ipcRenderer.invoke('get-hostname'),
  getLocalIp:      ()          => ipcRenderer.invoke('get-local-ip'),

  // ── Window Controls ───────────────────────────────────────
  minimize:        ()          => ipcRenderer.send('window-minimize'),
  maximize:        ()          => ipcRenderer.send('window-maximize'),
  close:           ()          => ipcRenderer.send('window-close'),

  // ── Event Listeners ───────────────────────────────────────
  onDeviceFound:       (cb) => ipcRenderer.on('device-found',        (_e, d) => cb(d)),
  onDeviceUpdated:     (cb) => ipcRenderer.on('device-updated',      (_e, d) => cb(d)),
  onDeviceConnected:   (cb) => ipcRenderer.on('device-connected',    (_e, d) => cb(d)),
  onDeviceDisconnected:(cb) => ipcRenderer.on('device-disconnected', (_e, d) => cb(d)),
  onTransferIncoming:  (cb) => ipcRenderer.on('transfer-incoming',   (_e, d) => cb(d)),
  onTransferProgress:  (cb) => ipcRenderer.on('transfer-progress',   (_e, d) => cb(d)),
  onTransferComplete:  (cb) => ipcRenderer.on('transfer-complete',   (_e, d) => cb(d)),
  onTransferCancelled: (cb) => ipcRenderer.on('transfer-cancelled',  (_e, d) => cb(d)),
  onScanTimeout:       (cb) => ipcRenderer.on('scan-timeout',        ()      => cb()),

  // ── Cleanup ───────────────────────────────────────────────
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
