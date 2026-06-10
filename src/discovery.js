// ═══════════════════════════════════════════════════════════
// Silo Discovery Service
// Broadcasts SILO_DISCOVER on the LAN and collects SILO_HELLO
// responses from Android devices running Silo Mobile.
// ═══════════════════════════════════════════════════════════

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
    this.knownDevices = new Map(); // ip → device info
  }

  // ── Public API ─────────────────────────────────────────────

  start() {
    // If already running just re-broadcast immediately (no duplicate cards)
    if (this.running) {
      this._broadcast();
      return;
    }

    // Clean up any leftover socket from a previous auto-stopped session
    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }

    this.running = true;
    // NOTE: Do NOT clear knownDevices here — devices already shown in UI
    // would be re-emitted as 'device-found' and create duplicate cards.

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

    // Auto-stop after 30 seconds
    this.autoStopTimer = setTimeout(() => {
      if (!this.running) return;
      // Stop broadcasting AND close socket so next start() can rebind cleanly
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

    // Don't clear knownDevices — they remain visible in the UI as 'previously seen'
    console.log('[Discovery] Stopped');
  }

  /** Remove all knowledge of a specific device (e.g. user manually forgets it). */
  forgetDevice(ip) {
    this.knownDevices.delete(ip);
  }

  getDevices() {
    return Array.from(this.knownDevices.values());
  }

  // ── Private ────────────────────────────────────────────────

  _getDesktopName() {
    return os.hostname();
  }

  _getLocalIP() {
    return this._getPreferredInterface()?.address ?? '127.0.0.1';
  }

  /**
   * Returns the best non-virtual IPv4 interface.
   * Priority: interface whose subnet contains the default gateway (i.e. a real LAN adapter).
   * Virtual adapters (VirtualBox 192.168.56.x, WSL 172.x, Hyper-V 172.x) are skipped.
   */
  _getPreferredInterface() {
    const interfaces = os.networkInterfaces();

    // Names/descriptions that indicate virtual/tunnel adapters to skip
    const virtualKeywords = ['virtualbox', 'vbox', 'vmware', 'vethernet', 'wsl',
                              'hyper-v', 'loopback', 'bluetooth', 'pseudo'];

    const candidates = [];
    for (const [name, iface] of Object.entries(interfaces)) {
      const nameLower = name.toLowerCase();
      if (virtualKeywords.some(k => nameLower.includes(k))) continue;

      for (const entry of iface) {
        if (entry.family !== 'IPv4' || entry.internal) continue;

        // Skip VirtualBox host-only range (192.168.56.x) and WSL/Hyper-V ranges (172.x)
        const firstOctet  = parseInt(entry.address.split('.')[0]);
        const secondOctet = parseInt(entry.address.split('.')[1]);
        if (entry.address.startsWith('192.168.56.')) continue;  // VirtualBox host-only
        if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) continue; // RFC 1918 WSL range

        candidates.push({ name, ...entry });
      }
    }

    if (candidates.length === 0) {
      // Fall back: return any non-internal IPv4
      for (const iface of Object.values(interfaces)) {
        for (const entry of iface) {
          if (entry.family === 'IPv4' && !entry.internal) return entry;
        }
      }
      return null;
    }

    // Prefer Wi-Fi or Ethernet by name hint
    const preferred = candidates.find(c =>
      c.name.toLowerCase().includes('wi-fi') ||
      c.name.toLowerCase().includes('wifi')  ||
      c.name.toLowerCase().includes('wlan')  ||
      c.name.toLowerCase().includes('ethernet')
    );
    return preferred ?? candidates[0];
  }

  _scheduleBroadcast() {
    // Fire immediately, then repeat
    this._broadcast();
    this.timer = setInterval(() => this._broadcast(), DISCOVERY_INTERVAL_MS);
  }

  _broadcast() {
    if (!this.running || !this.socket) return;

    const ip  = this._getLocalIP();
    const msg = Buffer.from(buildDiscover(this._getDesktopName(), ip));

    // Try all broadcast addresses
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
    // Always also try limited broadcast as fallback
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
        lastSeen:    Date.now(),   // non-null = seen alive in this scan session
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
