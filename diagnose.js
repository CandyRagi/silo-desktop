/**
 * Silo UDP Diagnostic Tool
 * Run with: node diagnose.js
 *
 * This listens on port 41234 and logs EVERY packet received,
 * and also sends a test broadcast every 2s so we can confirm
 * the desktop side is working independently of Electron.
 */

const dgram = require('dgram');
const os    = require('os');

// ── Get all IPv4 interfaces ──────────────────────────────
function getAllInterfaces() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(ifaces)) {
    for (const e of entries) {
      if (e.family === 'IPv4') {
        const ipParts   = e.address.split('.').map(Number);
        const maskParts = (e.netmask || '255.255.255.0').split('.').map(Number);
        const bcast     = ipParts.map((b, i) => (b | (~maskParts[i] & 0xff))).join('.');
        result.push({ name, ip: e.address, internal: e.internal, broadcast: bcast });
      }
    }
  }
  return result;
}

const ifaces = getAllInterfaces();
console.log('\n══════════════════════════════════════');
console.log('  Silo UDP Diagnostic');
console.log('══════════════════════════════════════');
console.log('\nAll IPv4 interfaces on this machine:');
ifaces.forEach(i => {
  const tag = i.internal ? '(loopback)' : '';
  console.log(`  ${i.name.padEnd(40)} ${i.ip.padEnd(16)} bcast→${i.broadcast} ${tag}`);
});

// ── Pick non-virtual Wi-Fi / Ethernet interface ──────────
const virtualKeywords = ['virtualbox','vbox','vmware','vethernet','wsl','hyper-v','bluetooth'];
const real = ifaces.filter(i =>
  !i.internal &&
  !virtualKeywords.some(k => i.name.toLowerCase().includes(k)) &&
  !i.ip.startsWith('192.168.56.') &&
  !(parseInt(i.ip.split('.')[0]) === 172 && parseInt(i.ip.split('.')[1]) >= 16 && parseInt(i.ip.split('.')[1]) <= 31)
);
const chosen = real.find(i => /wi.?fi|wlan|wireless|ethernet/i.test(i.name)) || real[0];

console.log('\n✓ Chosen interface for broadcast:');
if (chosen) {
  console.log(`  ${chosen.name} → ${chosen.ip}  (broadcast: ${chosen.broadcast})`);
} else {
  console.log('  ⚠ None found — check your Wi-Fi connection');
}

// ── UDP Socket ───────────────────────────────────────────
const PORT = 41234;
const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('error', err => {
  console.error('\n✕ Socket error:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error('  Port 41234 is already in use — close the Silo Desktop app first, then re-run this script.');
  }
  process.exit(1);
});

socket.on('message', (msg, rinfo) => {
  const text = msg.toString('utf8').trim();
  console.log(`\n📥 RECEIVED from ${rinfo.address}:${rinfo.port}`);
  console.log(`   "${text.substring(0, 120)}"`);

  // If it's a HELLO, that means the Android found us
  if (text.startsWith('SILO_HELLO')) {
    const parts = text.split('|');
    console.log(`\n🎉 ANDROID FOUND!`);
    console.log(`   Device: ${parts[1]}  IP: ${parts[2]}  Port: ${parts[3]}`);
  }
});

socket.bind(PORT, () => {
  socket.setBroadcast(true);
  console.log(`\n✓ Listening on UDP port ${PORT} — waiting for packets from any device...\n`);

  if (!chosen) { console.log('Cannot broadcast — no real interface found.'); return; }

  let count = 0;
  function sendBroadcast() {
    const msg = Buffer.from(`SILO_DISCOVER|${os.hostname()}|${chosen.ip}|41235`);
    // Send to subnet broadcast
    socket.send(msg, 0, msg.length, PORT, chosen.broadcast, err => {
      if (err) console.warn(`  ✕ Broadcast to ${chosen.broadcast} failed:`, err.message);
    });
    // Also send to limited broadcast
    socket.send(msg, 0, msg.length, PORT, '255.255.255.255', err => {
      if (err) console.warn(`  ✕ Broadcast to 255.255.255.255 failed:`, err.message);
    });
    count++;
    console.log(`📡 [${count}] Broadcast sent → ${chosen.broadcast} & 255.255.255.255`);
  }

  sendBroadcast();
  setInterval(sendBroadcast, 2000);
});

process.on('SIGINT', () => { socket.close(); console.log('\nStopped.'); process.exit(0); });
