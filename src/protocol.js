// ═══════════════════════════════════════════════════════════
// Silo Protocol — shared constants and message helpers
// ═══════════════════════════════════════════════════════════

const PORTS = {
  DISCOVERY: 41234,   // Both sides listen for broadcast on this port
  DESKTOP:   41235,   // Desktop transfer + pairing listener
  ANDROID:   41236,   // Android transfer + pairing listener (convention)
};

const MSG = {
  // Discovery
  DISCOVER:   'SILO_DISCOVER',   // Desktop → broadcast
  HELLO:      'SILO_HELLO',      // Android → desktop (unicast reply)

  // Pairing
  PAIR_REQ:   'SILO_PAIR_REQ',   // Desktop → Android  (with PIN)
  PAIR_ACK:   'SILO_PAIR_ACK',   // Android → Desktop  (accepted)
  PAIR_DENY:  'SILO_PAIR_DENY',  // Android → Desktop  (rejected / wrong PIN)

  // Transfer control
  TRANSFER_START: 'SILO_XFER_START',  // Sender announces file metadata
  TRANSFER_ACK:   'SILO_XFER_ACK',   // Receiver confirms ready
  CHUNK:          'SILO_CHUNK',       // File chunk
  ACK:            'SILO_ACK',         // Chunk acknowledged
  NACK:           'SILO_NACK',        // Chunk missing, please resend
  DONE:           'SILO_DONE',        // Transfer complete
  CANCEL:         'SILO_CANCEL',      // Abort transfer

  // Session
  PING:       'SILO_PING',
  PONG:       'SILO_PONG',
  DISCONNECT: 'SILO_DISCONNECT',
};

const CHUNK_SIZE = 60 * 1024;       // 60 KB data per chunk
const WINDOW_SIZE = 8;              // Chunks in flight simultaneously
const ACK_TIMEOUT_MS = 2000;        // ms before retransmit
const MAX_RETRIES = 5;
const DISCOVERY_INTERVAL_MS = 2000;
const SESSION_TIMEOUT_MS = 6000;   // Disconnect if no ping for this long

// ─── Message Builders ───────────────────────────────────────

function buildDiscover(desktopName, desktopIP) {
  return `${MSG.DISCOVER}|${desktopName}|${desktopIP}|${PORTS.DESKTOP}`;
}

function buildHello(deviceName, deviceIP) {
  return `${MSG.HELLO}|${deviceName}|${deviceIP}|${PORTS.ANDROID}`;
}

function buildPairReq(sessionId, desktopName, pin) {
  return `${MSG.PAIR_REQ}|${sessionId}|${desktopName}|${pin}`;
}

function buildPairAck(sessionId) {
  return `${MSG.PAIR_ACK}|${sessionId}`;
}

function buildPairDeny(sessionId, reason) {
  return `${MSG.PAIR_DENY}|${sessionId}|${reason}`;
}

function buildTransferStart(sessionId, fileId, fileName, fileSize, totalChunks, mimeType) {
  return `${MSG.TRANSFER_START}|${sessionId}|${fileId}|${encodeURIComponent(fileName)}|${fileSize}|${totalChunks}|${encodeURIComponent(mimeType || 'application/octet-stream')}`;
}

function buildTransferAck(sessionId, fileId) {
  return `${MSG.TRANSFER_ACK}|${sessionId}|${fileId}`;
}

function buildDone(sessionId, fileId) {
  return `${MSG.DONE}|${sessionId}|${fileId}`;
}

function buildCancel(sessionId, fileId) {
  return `${MSG.CANCEL}|${sessionId}|${fileId}`;
}

function buildPing(sessionId) {
  return `${MSG.PING}|${sessionId}`;
}

function buildPong(sessionId) {
  return `${MSG.PONG}|${sessionId}`;
}

function buildDisconnect(sessionId) {
  return `${MSG.DISCONNECT}|${sessionId}`;
}

// ─── Message Parsers ───────────────────────────────────────

/**
 * Parse an incoming Silo protocol message from a UDP datagram.
 * Returns { type, ...fields } or null if unrecognized.
 */
function parseMessage(data) {
  try {
    const str = data.toString('utf8');
    const parts = str.split('|');
    const type = parts[0];

    switch (type) {
      case MSG.DISCOVER:
        return { type, desktopName: parts[1], desktopIP: parts[2], desktopPort: parseInt(parts[3]) };

      case MSG.HELLO:
        return { type, deviceName: parts[1], deviceIP: parts[2], androidPort: parseInt(parts[3]) };

      case MSG.PAIR_REQ:
        return { type, sessionId: parts[1], desktopName: parts[2], pin: parts[3] };

      case MSG.PAIR_ACK:
        return { type, sessionId: parts[1] };

      case MSG.PAIR_DENY:
        return { type, sessionId: parts[1], reason: parts[2] };

      case MSG.TRANSFER_START:
        return {
          type,
          sessionId:   parts[1],
          fileId:      parts[2],
          fileName:    decodeURIComponent(parts[3]),
          fileSize:    parseInt(parts[4]),
          totalChunks: parseInt(parts[5]),
          mimeType:    decodeURIComponent(parts[6] || 'application/octet-stream'),
        };

      case MSG.TRANSFER_ACK:
        return { type, sessionId: parts[1], fileId: parts[2] };

      case MSG.DONE:
        return { type, sessionId: parts[1], fileId: parts[2] };

      case MSG.CANCEL:
        return { type, sessionId: parts[1], fileId: parts[2] };

      case MSG.PING:
        return { type, sessionId: parts[1] };

      case MSG.PONG:
        return { type, sessionId: parts[1] };

      case MSG.DISCONNECT:
        return { type, sessionId: parts[1] };

      default:
        return null;
    }
  } catch (e) {
    return null;
  }
}

/**
 * Build a binary CHUNK packet:
 * Header: "SILO_CHUNK|<sessionId>|<fileId>|<chunkIndex>|<totalChunks>|\n"
 * followed by raw binary data.
 */
function buildChunkPacket(sessionId, fileId, chunkIndex, totalChunks, chunkData) {
  const header = `${MSG.CHUNK}|${sessionId}|${fileId}|${chunkIndex}|${totalChunks}|\n`;
  const headerBuf = Buffer.from(header, 'utf8');
  return Buffer.concat([headerBuf, chunkData]);
}

/**
 * Parse a binary CHUNK packet. Returns { sessionId, fileId, chunkIndex, totalChunks, data } or null.
 */
function parseChunkPacket(buf) {
  try {
    const newlineIdx = buf.indexOf('\n');
    if (newlineIdx === -1) return null;
    const headerStr = buf.slice(0, newlineIdx).toString('utf8');
    const data = buf.slice(newlineIdx + 1);
    const parts = headerStr.split('|');
    if (parts[0] !== MSG.CHUNK) return null;
    return {
      type: MSG.CHUNK,
      sessionId:   parts[1],
      fileId:      parts[2],
      chunkIndex:  parseInt(parts[3]),
      totalChunks: parseInt(parts[4]),
      data,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Build an ACK/NACK text message for a specific chunk.
 */
function buildChunkAck(sessionId, fileId, chunkIndex) {
  return `${MSG.ACK}|${sessionId}|${fileId}|${chunkIndex}`;
}

function buildChunkNack(sessionId, fileId, chunkIndex) {
  return `${MSG.NACK}|${sessionId}|${fileId}|${chunkIndex}`;
}

function parseAckNack(data) {
  try {
    const str = data.toString('utf8');
    const parts = str.split('|');
    const type = parts[0];
    if (type !== MSG.ACK && type !== MSG.NACK) return null;
    return { type, sessionId: parts[1], fileId: parts[2], chunkIndex: parseInt(parts[3]) };
  } catch (e) {
    return null;
  }
}

module.exports = {
  PORTS,
  MSG,
  CHUNK_SIZE,
  WINDOW_SIZE,
  ACK_TIMEOUT_MS,
  MAX_RETRIES,
  DISCOVERY_INTERVAL_MS,
  SESSION_TIMEOUT_MS,
  buildDiscover,
  buildHello,
  buildPairReq,
  buildPairAck,
  buildPairDeny,
  buildTransferStart,
  buildTransferAck,
  buildDone,
  buildCancel,
  buildPing,
  buildPong,
  buildDisconnect,
  buildChunkPacket,
  buildChunkAck,
  buildChunkNack,
  parseMessage,
  parseChunkPacket,
  parseAckNack,
};
