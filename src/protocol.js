/**
 * File: protocol.js
 * Purpose: Defines Silo protocol constants, UDP message builders, and parsers.
 * Functions:
 * - buildDiscover, buildHello, buildPairReq, buildTransferStart, etc.: Message builder functions.
 * - parseMessage, parseChunkPacket, parseAckNack: Message parsing functions.
 */

const PORTS = {
  DISCOVERY: 41234,   
  DESKTOP:   41235,   
  ANDROID:   41236,   
};

const MSG = {
  
  DISCOVER:   'SILO_DISCOVER',   
  HELLO:      'SILO_HELLO',      

  PAIR_REQ:   'SILO_PAIR_REQ',   
  PAIR_ACK:   'SILO_PAIR_ACK',   
  PAIR_DENY:  'SILO_PAIR_DENY',  

  TRANSFER_START: 'SILO_XFER_START',  
  TRANSFER_ACK:   'SILO_XFER_ACK',   
  CHUNK:          'SILO_CHUNK',       
  ACK:            'SILO_ACK',         
  NACK:           'SILO_NACK',        
  DONE:           'SILO_DONE',        
  CANCEL:         'SILO_CANCEL',      

  PING:       'SILO_PING',
  PONG:       'SILO_PONG',
  DISCONNECT: 'SILO_DISCONNECT',

  MOUSE_MOVE: 'SILO_MOUSE_MOVE',
  MOUSE_CLICK: 'SILO_MOUSE_CLICK',
  KEYBOARD_INPUT: 'SILO_KEYBOARD_INPUT',
  CLIPBOARD_SYNC: 'SILO_CLIPBOARD',
  CAMERA_FRAME: 'SILO_CAM_FRAME',
  SCREEN_FRAME: 'SILO_SCREEN_FRAME',
};

const CHUNK_SIZE = 60 * 1024;       
const WINDOW_SIZE = 8;              
const ACK_TIMEOUT_MS = 2000;        
const MAX_RETRIES = 5;
const DISCOVERY_INTERVAL_MS = 2000;
const SESSION_TIMEOUT_MS = 6000;   

function buildDiscover(desktopName, desktopIP) {
  return `${MSG.DISCOVER}|${desktopName}|${desktopIP}|${PORTS.DESKTOP}`;
}

function buildHello(deviceName, deviceIP) {
  return `${MSG.HELLO}|${deviceName}|${deviceIP}|${PORTS.ANDROID}`;
}

function buildClipboardSync(base64Text) {
  return `${MSG.CLIPBOARD_SYNC}|${base64Text}`;
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

function parseMessage(data) {
  try {
    const str = data.toString('utf8');
    const parts = str.split('|');
    const type = parts[0];

    switch (type) {
      case MSG.DISCOVER:
        return { type, desktopName: parts[1], desktopIP: parts[2], desktopPort: parseInt(parts[3]) };

      case MSG.HELLO:
        return { type, deviceName: parts[4] && parts[4].trim() !== '' ? parts[4] : parts[1], deviceIP: parts[2], androidPort: parseInt(parts[3]) };

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

      case MSG.MOUSE_MOVE:
        return { type, sessionId: parts[1], dx: parseFloat(parts[2]), dy: parseFloat(parts[3]) };

      case MSG.MOUSE_CLICK:
        return { type, sessionId: parts[1], button: parts[2] };

      case MSG.KEYBOARD_INPUT:
        return { type, sessionId: parts[1], key: decodeURIComponent(parts[2].replace(/\+/g, '%20')) };

      case MSG.CLIPBOARD_SYNC:
        return { type, parts };

      default:
        return null;
    }
  } catch (e) {
    return null;
  }
}

function buildChunkPacket(sessionId, fileId, chunkIndex, totalChunks, chunkData) {
  const header = `${MSG.CHUNK}|${sessionId}|${fileId}|${chunkIndex}|${totalChunks}|\n`;
  const headerBuf = Buffer.from(header, 'utf8');
  return Buffer.concat([headerBuf, chunkData]);
}

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
  buildClipboardSync,
  parseMessage,
  parseChunkPacket,
  parseAckNack,
};
