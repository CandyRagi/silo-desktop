/**
 * File: renderer.js
 * Purpose: Renderer process logic. Handles UI interactions, state management, and updates DOM based on IPC events.
 * Functions:
 * - loadSavedDevices(), saveDeviceRecord(device), forgetDeviceRecord(ip): Local storage management.
 * - init(), restoreSavedDevices(): Initialization logic.
 * - toggleDiscovery(), refreshDiscovery(), startDiscovery(), updateScanLabel(), setScanState(): Discovery UI logic.
 * - registerAPIListeners(): IPC event listeners setup.
 * - addOrUpdateDevice(device), renderDeviceCard(device), createDeviceCard(device), deviceCardHTML(device), updateDeviceCard(device): Device UI rendering.
 * - openPairModal(deviceIP), _startCountdown(seconds), startPairing(), closePairModal(), showPinError(msg): Pairing UI logic.
 * - pickAndSend(deviceIP), sendFile(filePath, sessionId), disconnectDevice(deviceIP), forgetDevice(ip): File and session actions.
 * - renderTransfers(), transferItemHTML(t, key), updateTransferProgress(key, t), updateTransferBadge(): Transfer UI logic.
 * - renderHistory(), clearHistory(): History UI logic.
 * - changeSaveDir(), openSaveDir(), toggleAllowControl(checked): Settings UI logic.
 * - switchTab(name), toast(msg, type, onClick), escHtml(str), formatBytes(bytes), formatTime(ts), fileEmoji(name), updateCameraFilters(): Helpers.
 */

(function setupWindowControls() {
  document.getElementById('btn-minimize').addEventListener('click', function() { window.siloAPI.minimize(); });
  document.getElementById('btn-maximize').addEventListener('click', function() { window.siloAPI.maximize(); });
  document.getElementById('btn-close').addEventListener('click', function() { window.siloAPI.close(); });
})();

const SAVED_DEVICES_KEY = 'silo_saved_devices';

function loadSavedDevices() {
  try { return JSON.parse(localStorage.getItem(SAVED_DEVICES_KEY) || '{}'); }
  catch (_) { return {}; }
}

function saveDeviceRecord(device) {
  const saved = loadSavedDevices();
  saved[device.ip] = { name: device.name, ip: device.ip, port: device.port, lastConnected: Date.now() };
  localStorage.setItem(SAVED_DEVICES_KEY, JSON.stringify(saved));
}

function forgetDeviceRecord(ip) {
  const saved = loadSavedDevices();
  delete saved[ip];
  localStorage.setItem(SAVED_DEVICES_KEY, JSON.stringify(saved));
  state.devices.delete(ip);
  const card = document.getElementById(`device-${ip.replace(/\./g, '-')}`);
  if (card) card.remove();
  updateDeviceCountBadge();
}

const state = {
  scanning:    false,
  devices:     new Map(),  
  transfers:   new Map(),  
  history:     [],
  pendingPair: null,  
};

async function init() {
  const hostname = await window.siloAPI.getHostname();
  document.getElementById('desktop-name').textContent = hostname;
  document.getElementById('settings-hostname').textContent = hostname;

  const saveDir = await window.siloAPI.getSaveDir();
  document.getElementById('save-dir-label').textContent = saveDir;

  const allowControl = localStorage.getItem('allow_control') !== 'false';
  document.getElementById('setting-allow-control').checked = allowControl;
  window.siloAPI.setAllowControl(allowControl);

  registerAPIListeners();

  restoreSavedDevices();

  const savedHistory = await window.siloAPI.getHistory();
  if (savedHistory && savedHistory.length > 0) {
    state.history = savedHistory;
    renderHistory();
  }

  setScanState(false);
}

function restoreSavedDevices() {
  const saved = loadSavedDevices();
  for (const record of Object.values(saved)) {
    const device = { ...record, connected: false, sessionId: null, lastSeen: null };
    state.devices.set(device.ip, device);
    renderDeviceCard(device);
  }
  updateDeviceCountBadge();
}

let discoveryRunning = false;
let _scanCountdownTimer = null;

function getConnectedDevice() {
  for (const dev of state.devices.values()) {
    if (dev.connected) return dev;
  }
  return null;
}

async function toggleDiscovery() {
  if (discoveryRunning) {
    await window.siloAPI.stopDiscovery();
    discoveryRunning = false;
    clearInterval(_scanCountdownTimer);
    setScanState(false);
  } else {
    const connectedDev = getConnectedDevice();
    if (connectedDev) {
      if (confirm(`You are currently connected to ${connectedDev.name}.\n\nDo you want to disconnect and scan for other devices?`)) {
        disconnectDevice(connectedDev.ip);
        startDiscovery();
      }
    } else {
      startDiscovery();
    }
  }
}

async function refreshDiscovery() {
  const connectedDev = getConnectedDevice();
  if (connectedDev) {
    if (!confirm(`You are currently connected to ${connectedDev.name}.\n\nDo you want to disconnect and scan for other devices?`)) {
      return;
    }
    disconnectDevice(connectedDev.ip);
  }

  const icon = document.querySelector('.tab-header button svg');
  if (icon) icon.style.animation = 'spin 1s linear infinite';

  await window.siloAPI.startDiscovery();
  setTimeout(async () => {
    if (!discoveryRunning) {
      await window.siloAPI.stopDiscovery();
    }
    if (icon) icon.style.animation = 'none';
  }, 2500);
}

async function startDiscovery() {
  await window.siloAPI.startDiscovery();
  discoveryRunning = true;
  setScanState(true);

  let remaining = 30;
  clearInterval(_scanCountdownTimer);
  _scanCountdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(_scanCountdownTimer);
      discoveryRunning = false;
      setScanState(false);
      window.siloAPI.stopDiscovery();
    }
  }, 1000);
}

function updateScanLabel() {
  const label = document.getElementById('scan-label');
  const connectedDev = getConnectedDevice();
  if (connectedDev) {
    label.textContent = 'Connected';
    label.style.color = '#818cf8';
  } else {
    label.textContent = 'Idle';
    label.style.color = 'inherit';
  }
}

function setScanState(scanning) {
  const dot   = document.getElementById('scan-dot');
  const btn   = document.getElementById('btn-scan');

  updateScanLabel();

  if (scanning) {
    dot.className   = 'scan-dot scanning';
    btn.className = 'btn btn-scan-scanning btn--full';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg> Stop Scanning`;
  } else {
    dot.className   = 'scan-dot';
    btn.className = 'btn btn-scan-idle btn--full';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Scan for Devices`;
  }
}

setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const [ip, dev] of state.devices.entries()) {
    
    if (!dev.connected && dev.lastSeen && (now - dev.lastSeen > 6000)) {
      dev.lastSeen = null;
      changed = true;
    }
  }
  if (changed) {
    for (const dev of state.devices.values()) {
      updateDeviceCard(dev);
    }
  }
  updateScanLabel();
}, 2000);

function registerAPIListeners() {
  window.siloAPI.onDeviceFound((device) => {
    addOrUpdateDevice(device);
  });

  window.siloAPI.onDeviceUpdated((device) => {
    addOrUpdateDevice(device);
  });

  window.siloAPI.onScanTimeout(() => {
    clearInterval(_scanCountdownTimer);
    discoveryRunning = false;
    setScanState(false);
  });

  window.siloAPI.onDeviceConnected((info) => {
    const dev = state.devices.get(info.ip);
    if (dev) {
      dev.connected  = true;
      dev.sessionId  = info.sessionId;
      updateDeviceCard(dev);
      saveDeviceRecord(dev);
    }
    toast(`Connected to ${dev?.name || info.ip}`, 'success');
    updateScanDot();
    
    if (discoveryRunning) {
      clearInterval(_scanCountdownTimer);
      discoveryRunning = false;
      setScanState(false);
      window.siloAPI.stopDiscovery();
    }
  });

  window.siloAPI.onDeviceDisconnected((info) => {
    for (const [ip, dev] of state.devices.entries()) {
      if (dev.sessionId === info.sessionId) {
        dev.connected = false;
        dev.sessionId = null;
        updateDeviceCard(dev);
        break;
      }
    }
    toast('Device disconnected', 'info');
    updateScanDot();
  });

  window.siloAPI.onTransferIncoming((info) => {
    const key = `${info.sessionId}:${info.fileId}`;
    state.transfers.set(key, { ...info, progress: 0, direction: 'receive', startTime: Date.now() });
    renderTransfers();
    toast(`Receiving: ${info.fileName}`, 'info');
    switchTab('transfers');
  });

  window.siloAPI.onTransferProgress((info) => {
    const key = `${info.sessionId}:${info.fileId}`;
    const t = state.transfers.get(key) || { ...info };
    t.progress   = info.progress;
    t.bytesInfo  = info.bytesReceived || info.bytesSent || 0;
    t.totalBytes = info.totalBytes;
    t.direction  = info.direction || t.direction || 'receive';
    state.transfers.set(key, t);
    updateTransferProgress(key, t);
  });

  window.siloAPI.onTransferComplete((info) => {
    const key = `${info.sessionId}:${info.fileId}`;
    state.transfers.delete(key);

    state.history.unshift({
      ...info,
      timestamp: Date.now(),
      savedPath: info.savedPath,
    });
    if (state.history.length > 100) state.history.length = 100;

    renderTransfers();
    renderHistory();
    updateTransferBadge();

    toast(`✓ ${info.fileName} — transfer complete`, 'success', () => {
      if (info.savedPath) window.siloAPI.revealFile({ filePath: info.savedPath });
    });
  });

  window.siloAPI.onTransferCancelled((info) => {
    const key = `${info.sessionId}:${info.fileId}`;
    state.transfers.delete(key);
    renderTransfers();
    toast('Transfer cancelled', 'error');
  });

  let cameraStreamTimeout = null;
  window.manualRotationOffset = 0;
  window.lastReportedRotation = 0;

  window.siloAPI.onCameraFrame((data) => {
    const img = document.getElementById('camera-feed');
    const placeholder = document.getElementById('camera-placeholder');
    if (img) {
      img.src = 'data:image/jpeg;base64,' + data.base64;
      window.lastReportedRotation = data.rotation || 0;
      const finalRotation = (window.lastReportedRotation + window.manualRotationOffset) % 360;
      img.style.transform = `rotate(${finalRotation}deg) scale(0.97)`;

      updateCameraFilters();

      img.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';

      clearTimeout(cameraStreamTimeout);
      cameraStreamTimeout = setTimeout(() => {
        img.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
      }, 500);
    }
  });

  let screenStreamTimeout = null;
  window.screenRotationOffset = 0;

  window.siloAPI.onScreenFrame((data) => {
    const img = document.getElementById('screen-feed');
    const placeholder = document.getElementById('screen-placeholder');
    if (img) {
      img.src = 'data:image/jpeg;base64,' + data.base64;
      img.style.transform = `rotate(${window.screenRotationOffset}deg) scale(0.97)`;
      
      img.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';

      clearTimeout(screenStreamTimeout);
      screenStreamTimeout = setTimeout(() => {
        img.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
      }, 2000);
    }
  });

}

function addOrUpdateDevice(device) {
  
  const existing = state.devices.get(device.ip);
  const merged = { ...existing, ...device };
  state.devices.set(device.ip, merged);

  const grid  = document.getElementById('devices-grid');
  const empty = document.getElementById('devices-empty');
  grid.style.display  = 'grid';
  empty.style.display = 'none';

  const cardId = `device-${device.ip.replace(/\./g, '-')}`;
  if (document.getElementById(cardId)) {
    
    updateDeviceCard(merged);
  } else {
    
    const card = createDeviceCard(merged);
    grid.appendChild(card);
  }

  updateDeviceCountBadge();
}

function renderDeviceCard(device) {
  const grid  = document.getElementById('devices-grid');
  const empty = document.getElementById('devices-empty');
  grid.style.display  = 'grid';
  empty.style.display = 'none';

  const cardId = `device-${device.ip.replace(/\./g, '-')}`;
  if (!document.getElementById(cardId)) {
    grid.appendChild(createDeviceCard(device));
  }
}

function createDeviceCard(device) {
  const id  = `device-${device.ip.replace(/\./g, '-')}`;
  const div = document.createElement('div');
  div.className = `device-card${device.connected ? ' connected' : ''}`;
  div.id = id;
  div.innerHTML = deviceCardHTML(device);

  div.addEventListener('dragover', (e) => {
    if (!device.connected) return;
    e.preventDefault();
    div.classList.add('drop-target');
  });
  div.addEventListener('dragleave', () => div.classList.remove('drop-target'));
  div.addEventListener('drop', (e) => {
    e.preventDefault();
    div.classList.remove('drop-target');
    const dev = state.devices.get(device.ip);
    if (!dev?.connected) { toast('Connect to this device first', 'error'); return; }
    const files = Array.from(e.dataTransfer.files).map(f => f.path);
    files.forEach(fp => sendFile(fp, dev.sessionId));
  });

  return div;
}

function deviceCardHTML(device) {
  const dev       = state.devices.get(device.ip) || device;
  const connected = dev.connected || device.connected;
  const isLive    = dev.lastSeen != null;          
  const wasSaved  = !!loadSavedDevices()[device.ip]; 

  let statusClass, statusLabel;
  if (connected)       { statusClass = 'connected'; statusLabel = 'Connected'; }
  else if (isLive)     { statusClass = 'online';    statusLabel = 'Available'; }
  else if (wasSaved)   { statusClass = 'saved';     statusLabel = 'Last Seen'; }
  else                 { statusClass = 'online';    statusLabel = 'Available'; }

  const forgetBtn = wasSaved && !connected
    ? `<button class="btn btn--ghost btn--sm btn--icon forget-btn" title="Forget device" onclick="forgetDevice('${device.ip}')">✕</button>`
    : '';

  const opacityStyle = (wasSaved && !isLive && !connected) ? 'opacity: 0.5; filter: grayscale(0.5);' : '';
  const initial = device.name ? device.name.charAt(0).toUpperCase() : '?';

  return `
    <div class="device-card-inner" style="${opacityStyle}">
      <div class="device-card-header">
        <div class="device-avatar-large">
          ${initial}
        </div>
        <div class="device-card-info">
          <div class="device-card-name">${escHtml(device.name)}</div>
          <div class="device-card-ip">${device.ip}</div>
        </div>
        <div class="device-status-wrap">
          <div class="device-status-dot ${statusClass}" title="${statusLabel}"></div>
          ${forgetBtn}
        </div>
      </div>
      <div class="device-card-actions">
        ${connected
          ? `<button class="btn btn--primary btn--sm" style="flex:1; border-radius: 20px;" onclick="pickAndSend('${device.ip}')">
               Send File
             </button>
             <button class="btn btn--danger btn--sm" style="flex:1; border-radius: 20px; background: transparent; color: var(--red); border: 1px solid rgba(239,68,68,0.3);" onclick="disconnectDevice('${device.ip}')">
               Disconnect
             </button>`
          : `<button class="btn btn--primary btn--sm" style="flex:1; border-radius: 20px;" onclick="openPairModal('${device.ip}')" ${!isLive ? 'disabled' : ''}>
               Connect
             </button>`
        }
      </div>
    </div>
  `;
}

function updateDeviceCard(device) {
  const id  = `device-${device.ip.replace(/\./g, '-')}`;
  const el  = document.getElementById(id);
  if (!el) return;
  el.className = `device-card${device.connected ? ' connected' : ''}`;
  el.innerHTML = deviceCardHTML(device);
}

function updateDeviceCountBadge() {
  const count = state.devices.size;
  const badge = document.getElementById('device-count-badge');
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function updateScanDot() {
  const anyConnected = Array.from(state.devices.values()).some(d => d.connected);
  const dot = document.getElementById('scan-dot');
  if (anyConnected) {
    dot.className = 'scan-dot connected';
    document.getElementById('scan-label').textContent = 'Connected';
  } else if (discoveryRunning) {
    dot.className = 'scan-dot scanning';
    document.getElementById('scan-label').textContent = 'Scanning…';
  }
}

let _countdownTimer = null;

function openPairModal(deviceIP) {
  const device = state.devices.get(deviceIP);
  if (!device) return;

  const connectedDev = getConnectedDevice();
  if (connectedDev && connectedDev.ip !== deviceIP) {
    if (confirm(`You are currently connected to ${connectedDev.name}.\n\nDo you want to disconnect and connect to ${device.name}?`)) {
      disconnectDevice(connectedDev.ip);
    } else {
      return;
    }
  }

  const pin = "000000"; 
  state.pendingPair = { ip: device.ip, port: device.port, name: device.name, pin };

  document.getElementById('modal-device-name').textContent = device.name;
  document.getElementById('modal-error').style.display = 'none';
  document.getElementById('btn-pair-cancel').textContent = 'Cancel';
  document.getElementById('btn-pair-cancel').onclick = closePairModal;
  document.getElementById('modal-overlay').style.display = 'flex';

  _startCountdown(90);
  startPairing();
}

function _startCountdown(seconds) {
  clearInterval(_countdownTimer);
  let remaining = seconds;
  const label = document.getElementById('pair-btn-text');
  label.textContent = `Waiting for phone… ${remaining}s`;
  _countdownTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      label.textContent = `Waiting for phone… ${remaining}s`;
    } else {
      clearInterval(_countdownTimer);
    }
  }, 1000);
}

async function startPairing() {
  if (!state.pendingPair) return;
  const { ip, port, pin } = state.pendingPair;

  const result = await window.siloAPI.connectDevice({ ip, port, pin });

  clearInterval(_countdownTimer);

  if (!state.pendingPair) return;

  if (result.ok) {
    closePairModal();
    const dev = state.devices.get(ip);
    if (dev) {
      dev.connected = true;
      dev.sessionId = result.sessionId;
      updateDeviceCard(dev);
    }
    updateScanDot();
    toast(`Paired with ${dev?.name ?? ip}`, 'success');
  } else {
    document.getElementById('pair-btn-text').textContent = 'Timed out';
    showPinError(result.error || 'Phone did not respond in time');
    
    const cancelBtn = document.getElementById('btn-pair-cancel');
    cancelBtn.textContent = 'Retry';
    cancelBtn.onclick = () => openPairModal(state.pendingPair?.ip ?? ip);
  }
}

function closePairModal() {
  clearInterval(_countdownTimer);
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('modal-error').style.display = 'none';
  state.pendingPair = null;
}

function showPinError(msg) {
  const el = document.getElementById('modal-error');
  el.textContent = '⚠ ' + msg;
  el.style.display = 'flex';
}

async function pickAndSend(deviceIP) {
  const dev = state.devices.get(deviceIP);
  if (!dev?.connected) { toast('Device not connected', 'error'); return; }

  const files = await window.siloAPI.pickFiles();
  for (const fp of files) {
    await sendFile(fp, dev.sessionId);
  }
}

async function sendFile(filePath, sessionId) {
  const result = await window.siloAPI.sendFile({ filePath, sessionId });
  if (!result.ok) toast(`Send failed: ${result.error}`, 'error');
}

function disconnectDevice(deviceIP) {
  const dev = state.devices.get(deviceIP);
  if (!dev?.connected) return;
  window.siloAPI.disconnectDevice({ sessionId: dev.sessionId });
  dev.connected = false;
  dev.sessionId = null;
  updateDeviceCard(dev);
  updateScanDot();
}

function forgetDevice(ip) {
  forgetDeviceRecord(ip);
  state.devices.delete(ip);
  window.siloAPI.forgetDevice(ip);
  const cardId = `device-${ip.replace(/\./g, '-')}`;
  document.getElementById(cardId)?.remove();
  updateDeviceCountBadge();
  const grid = document.getElementById('devices-grid');
  if (state.devices.size === 0) {
    grid.style.display = 'none';
    document.getElementById('devices-empty').style.display = 'flex';
  }
  toast('Device forgotten', 'info');
}

function renderTransfers() {
  const list  = document.getElementById('transfers-list');
  const empty = document.getElementById('transfers-empty');

  if (state.transfers.size === 0) {
    list.style.display  = 'none';
    empty.style.display = 'flex';
    updateTransferBadge();
    return;
  }

  list.style.display  = 'flex';
  empty.style.display = 'none';
  list.innerHTML = '';

  for (const [key, t] of state.transfers.entries()) {
    const el = document.createElement('div');
    el.className = 'transfer-item';
    el.id = `transfer-${key.replace(/[^a-z0-9]/gi, '-')}`;
    el.innerHTML = transferItemHTML(t, key);
    list.appendChild(el);
  }

  updateTransferBadge();
}

function transferItemHTML(t, key) {
  const emoji = fileEmoji(t.fileName);
  const size  = formatBytes(t.totalBytes || 0);
  const dir   = t.direction === 'send' ? 'Sending' : 'Receiving';
  return `
    <div class="transfer-top">
      <div class="transfer-file-icon">${emoji}</div>
      <div class="transfer-info">
        <div class="transfer-name">${escHtml(t.fileName)}</div>
        <div class="transfer-meta">${dir} · ${size}</div>
      </div>
      <span class="transfer-badge ${t.direction}">${dir}</span>
    </div>
    <div class="progress-bar-track">
      <div class="progress-bar-fill" id="progress-${key.replace(/[^a-z0-9]/gi, '-')}" style="width:${t.progress || 0}%"></div>
    </div>
    <div class="progress-stats">
      <span>${t.progress || 0}%</span>
      <span>${formatBytes(t.bytesInfo || 0)} / ${size}</span>
    </div>`;
}

function updateTransferProgress(key, t) {
  const safeKey = key.replace(/[^a-z0-9]/gi, '-');
  const bar = document.getElementById(`progress-${safeKey}`);
  if (bar) {
    bar.style.width = `${t.progress}%`;
    const item = document.getElementById(`transfer-${safeKey}`);
    if (item) {
      const stats = item.querySelectorAll('.progress-stats span');
      if (stats[0]) stats[0].textContent = `${t.progress}%`;
      if (stats[1]) stats[1].textContent = `${formatBytes(t.bytesInfo || 0)} / ${formatBytes(t.totalBytes || 0)}`;
    }
  } else {
    renderTransfers();
  }
}

function updateTransferBadge() {
  const count = state.transfers.size;
  const badge = document.getElementById('active-count-badge');
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function renderHistory() {
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');

  if (state.history.length === 0) {
    list.style.display  = 'none';
    empty.style.display = 'flex';
    return;
  }

  list.style.display  = 'flex';
  empty.style.display = 'none';
  list.innerHTML = '';

  for (const item of state.history) {
    const el = document.createElement('div');
    el.className = `history-item history-${item.direction}`;
    el.innerHTML = `
      <div class="history-item-icon">${fileEmoji(item.fileName)}</div>
      <div class="history-item-info">
        <div class="history-item-name">${escHtml(item.fileName)}</div>
        <div class="history-item-meta">${formatBytes(item.totalBytes)} · ${item.direction === 'send' ? 'Sent' : 'Received'} · ${formatTime(item.timestamp)}</div>
      </div>
      <span class="transfer-badge done">Done</span>
      ${item.savedPath ? '<div class="history-item-reveal" title="Show in folder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></div>' : ''}`;

    if (item.savedPath) {
      el.onclick = () => window.siloAPI.revealFile({ filePath: item.savedPath });
    }
    list.appendChild(el);
  }
}

function clearHistory() {
  state.history.length = 0;
  renderHistory();
}

async function changeSaveDir() {
  const result = await window.siloAPI.setSaveDir();
  if (result.ok) {
    document.getElementById('save-dir-label').textContent = result.dir;
    toast('Save location updated', 'success');
  }
}

async function openSaveDir() {
  await window.siloAPI.openSaveDir();
}

function toggleAllowControl(checked) {
  localStorage.setItem('allow_control', checked);
  window.siloAPI.setAllowControl(checked);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`tab-${name}`)?.classList.add('active');
  document.getElementById(`nav-${name}`)?.classList.add('active');
}

function toast(msg, type = 'info', onClick) {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span style="color:${type==='success'?'#4ade80':type==='error'?'#f87171':'#818cf8'}">${icons[type]}</span> ${escHtml(msg)}`;
  if (onClick) { el.style.cursor = 'pointer'; el.addEventListener('click', onClick); }
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, 4000);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fileEmoji(name) {
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-muted)"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;
}

document.addEventListener('DOMContentLoaded', init);

function updateCameraFilters() {
  const brightness = document.getElementById('cam-brightness').value;
  const contrast = document.getElementById('cam-contrast').value;
  const saturation = document.getElementById('cam-saturation').value;
  const grayscale = document.getElementById('cam-grayscale').value;

  const bLabel = document.getElementById('val-cam-brightness');
  if (bLabel) bLabel.textContent = `${brightness}%`;
  const cLabel = document.getElementById('val-cam-contrast');
  if (cLabel) cLabel.textContent = `${contrast}%`;
  const sLabel = document.getElementById('val-cam-saturation');
  if (sLabel) sLabel.textContent = `${saturation}%`;
  const gLabel = document.getElementById('val-cam-grayscale');
  if (gLabel) gLabel.textContent = `${grayscale}%`;

  const img = document.getElementById('camera-feed');
  if (img) {
    
    img.style.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) grayscale(${grayscale}%)`;
  }
}

function resetCameraFilters() {
  document.getElementById('cam-brightness').value = 100;
  document.getElementById('cam-contrast').value = 100;
  document.getElementById('cam-saturation').value = 100;
  document.getElementById('cam-grayscale').value = 0;
  window.manualRotationOffset = 0;
  updateCameraFilters();
}

window.rotateCamera = function() {
  window.manualRotationOffset = (window.manualRotationOffset + 90) % 360;
  const img = document.getElementById('camera-feed');
  if (img) {
    const finalRotation = (window.lastReportedRotation + window.manualRotationOffset) % 360;
    img.style.transform = `rotate(${finalRotation}deg) scale(0.97)`;
  }
}

window.updateScreenScaleMode = function(mode) {
  const img = document.getElementById('screen-feed');
  if (img) {
    img.style.objectFit = mode;
    if (mode === 'cover') {
      img.style.width = '100%';
      img.style.height = '100%';
    } else {
      img.style.width = '';
      img.style.height = '';
    }
  }
};

window.updateScreenRotation = function(rot) {
  window.screenRotationOffset = parseInt(rot, 10) || 0;
  const img = document.getElementById('screen-feed');
  if (img) {
    img.style.transform = `rotate(${window.screenRotationOffset}deg) scale(0.97)`;
  }
};

window.copyScreenOBSLink = function() {
  navigator.clipboard.writeText('http://localhost:18080/screen').then(() => {
    toast('Screen Stream URL copied to clipboard', 'success');
  }).catch(err => {
    toast('Failed to copy link', 'error');
  });
};

window.resetCameraFilters = resetCameraFilters;
document.addEventListener('DOMContentLoaded', () => {
  ['brightness', 'contrast', 'saturation', 'grayscale'].forEach(filter => {
    const el = document.getElementById(`cam-${filter}`);
    if (el) {
      el.addEventListener('input', updateCameraFilters);
    }
  });
});

window.copyOBSLink = function() {
  navigator.clipboard.writeText('http://localhost:18080/stream').then(() => {
    toast('OBS Link copied to clipboard', 'success');
  }).catch(err => {
    toast('Failed to copy link', 'error');
  });
};

