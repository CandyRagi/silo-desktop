/**
 * File: discovery.js
 * Purpose: DiscoveryService class for finding Silo devices on the local network using UDP broadcasts.
 * Functions:
 * - start(), stop(): Lifecycle methods.
 * - forgetDevice(ip), getDevices(): Device state management.
 * - _getDesktopName(), _getLocalIP(), _getPreferredInterface(): Network adapters enumeration.
 * - _scheduleBroadcast(), _broadcast(), _getBroadcastAddresses(): Broadcast loop logic.
 * - _handleMessage(buf, rinfo): Parses incoming UDP messages.
 * - markConnected(ip, sessionId), markDisconnected(ip): State toggles.
 */

const dgram = require('dgram');
const os    = require('os');
const { EventEmitter } = require('events');
const {
  PORTS,
  MSG,
  DISCOVERY_INTERVAL_MS,
  buildDiscover,
  parseMessage,
} = require('./protocol');

class DiscoveryService extends EventEmitter {
  constructor() {
    super();
    this.socket       = null;
    this.timer        = null;
    this.autoStopTimer = null;
    this.running      = false;
    this.knownDevices = new Map(); 
  }

  start() {
    if (this.running) {
      this._broadcast();
      return;
    }
    
    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }

    this.running = true;

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      console.error('[Discovery] Socket error:', err.message);
      this.emit('error', err);
    });

    this.socket.on('message', (msg, rinfo) => {
      this._handleMessage(msg, rinfo);
    });

    this.socket.bind(PORTS.DISCOVERY, () => {
      try {
        this.socket.setBroadcast(true);
      } catch (e) {
        console.warn('[Discovery] setBroadcast failed:', e.message);
      }
      this._scheduleBroadcast();
      console.log(`[Discovery] Listening on port ${PORTS.DISCOVERY}`);
    });

    this.autoStopTimer = setTimeout(() => {
      if (!this.running) return;
      
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.running = false;
      if (this.socket) {
        try { this.socket.close(); } catch (_) {}
        this.socket = null;
      }
      console.log('[Discovery] Auto-stopped after 30 s');
      this.emit('scan-timeout');
    }, 30000);
  }

  stop() {
    if (!this.running && !this.socket) return;
    this.running = false;

    if (this.autoStopTimer) { clearTimeout(this.autoStopTimer); this.autoStopTimer = null; }
    if (this.timer)         { clearInterval(this.timer); this.timer = null; }

    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }

    console.log('[Discovery] Stopped');
  }

  forgetDevice(ip) {
    this.knownDevices.delete(ip);
  }

  getDevices() {
    return Array.from(this.knownDevices.values());
  }

  _getDesktopName() {
    return os.hostname();
  }

  _getLocalIP() {
    return this._getPreferredInterface()?.address ?? '127.0.0.1';
  }

  _getPreferredInterface() {
    const interfaces = os.networkInterfaces();

    const virtualKeywords = ['virtualbox', 'vbox', 'vmware', 'vethernet', 'wsl',
                              'hyper-v', 'loopback', 'bluetooth', 'pseudo'];

    const candidates = [];
    for (const [name, iface] of Object.entries(interfaces)) {
      const nameLower = name.toLowerCase();
      if (virtualKeywords.some(k => nameLower.includes(k))) continue;

      for (const entry of iface) {
        if (entry.family !== 'IPv4' || entry.internal) continue;

        const firstOctet  = parseInt(entry.address.split('.')[0]);
        const secondOctet = parseInt(entry.address.split('.')[1]);
        if (entry.address.startsWith('192.168.56.')) continue;  
        if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) continue; 

        candidates.push({ name, ...entry });
      }
    }

    if (candidates.length === 0) {
      
      for (const iface of Object.values(interfaces)) {
        for (const entry of iface) {
          if (entry.family === 'IPv4' && !entry.internal) return entry;
        }
      }
      return null;
    }

    const preferred = candidates.find(c =>
      c.name.toLowerCase().includes('wi-fi') ||
      c.name.toLowerCase().includes('wifi')  ||
      c.name.toLowerCase().includes('wlan')  ||
      c.name.toLowerCase().includes('ethernet')
    );
    return preferred ?? candidates[0];
  }

  _scheduleBroadcast() {
    
    this._broadcast();
    this.timer = setInterval(() => this._broadcast(), DISCOVERY_INTERVAL_MS);
  }

  _broadcast() {
    if (!this.running || !this.socket) return;

    const ip  = this._getLocalIP();
    const msg = Buffer.from(buildDiscover(this._getDesktopName(), ip));

    const targets = this._getBroadcastAddresses();
    targets.push('255.255.255.255');

    for (const bcast of targets) {
      this.socket.send(msg, 0, msg.length, PORTS.DISCOVERY, bcast, (err) => {
        if (err) console.warn(`[Discovery] Broadcast to ${bcast} failed:`, err.message);
      });
    }
  }

  _getBroadcastAddresses() {
    const addrs = [];
    const iface = this._getPreferredInterface();
    if (iface && iface.netmask) {
      try {
        const ipParts   = iface.address.split('.').map(Number);
        const maskParts = iface.netmask.split('.').map(Number);
        const bcast = ipParts.map((b, i) => (b | (~maskParts[i] & 0xff))).join('.');
        addrs.push(bcast);
        console.log(`[Discovery] Broadcasting on ${iface.name} (${iface.address}) → ${bcast}`);
      } catch (_) {}
    }
    
    if (!addrs.includes('255.255.255.255')) addrs.push('255.255.255.255');
    return addrs;
  }

  _handleMessage(buf, rinfo) {
    const parsed = parseMessage(buf);
    if (!parsed) return;

    if (parsed.type === MSG.HELLO) {
      const { deviceName, deviceIP, androidPort } = parsed;
      const key = deviceIP;

      const isNew = !this.knownDevices.has(key);
      const device = {
        name:        deviceName,
        ip:          deviceIP,
        port:        androidPort,
        lastSeen:    Date.now(),   
        connected:   false,
        sessionId:   null,
      };

      this.knownDevices.set(key, device);

      if (isNew) {
        console.log(`[Discovery] Found device: ${deviceName} @ ${deviceIP}:${androidPort}`);
        this.emit('device-found', { ...device });
      } else {
        this.emit('device-updated', { ...device });
      }
    }
  }

  markConnected(ip, sessionId) {
    const dev = this.knownDevices.get(ip);
    if (dev) {
      dev.connected = true;
      dev.sessionId = sessionId;
    }
  }

  markDisconnected(ip) {
    const dev = this.knownDevices.get(ip);
    if (dev) {
      dev.connected = false;
      dev.sessionId = null;
    }
  }
}

module.exports = DiscoveryService;
