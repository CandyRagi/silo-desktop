/**
 * File: transfer.js
 * Purpose: TransferManager class for handling device pairing, file transfers, and remote control over UDP.
 * Functions:
 * - start(), stop(): Lifecycle and socket binding.
 * - setSaveDir(dir), getSaveDir(), setAllowControl(allow): Accessors.
 * - pairDevice(...): Starts pairing flow.
 * - sendFile(filePath, sessionId): Reads a file and sends it over UDP in chunks.
 * - disconnectSession(sessionId): Closes an active session.
 * - _send(msgStr, ip, port), _handleRaw(buf, rinfo), _handleChunk(), _handlePairAck(), etc.: Socket IO handlers.
 * - _startKeepalive(sessionId): Starts ping loop.
 * - _sendChunkWithRetry(...): Sends a UDP chunk and awaits ACK.
 * - _waitForEvent(...): Promisifies EventEmitter.
 * - _assembleFile(transfer), _safeFilename(name), _uniquePath(p): File reconstruction logic.
 */

const dgram  = require('dgram');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { clipboard } = require('electron');

const {
  PORTS, MSG,
  CHUNK_SIZE, WINDOW_SIZE, ACK_TIMEOUT_MS, MAX_RETRIES, SESSION_TIMEOUT_MS,
  buildPairReq, buildPairAck, buildPairDeny,
  buildTransferStart, buildTransferAck, buildDone, buildCancel,
  buildPing, buildPong, buildDisconnect,
  buildChunkPacket, buildChunkAck, buildChunkNack,
  buildClipboardSync,
  parseMessage, parseChunkPacket, parseAckNack,
} = require('./protocol');

class TransferManager extends EventEmitter {
  constructor() {
    super();
    this.socket      = null;
    this.sessions    = new Map();   
    this.saveDir     = path.join(os.homedir(), 'Downloads', 'Silo');
    this._pendingPairReqs = new Map(); 
    this._inboundTransfers = new Map(); 
    this._outboundTransfers = new Map(); 
    this.allowControl = true;
    this._lastClipboardText = '';
  }

  start() {
    if (this.socket) return;

    fs.mkdirSync(this.saveDir, { recursive: true });

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    setInterval(() => {
      if (this.sessions.size > 0 && this.allowControl) {
        try {
          const text = clipboard.readText();
          if (text && text !== this._lastClipboardText) {
            this._lastClipboardText = text;
            const base64 = Buffer.from(text).toString('base64');
            const msg = buildClipboardSync(base64);
            console.log(`[Clipboard] Sending new clipboard to Android (${text.length} chars)`);
            for (const [sid, session] of this.sessions.entries()) {
              this._send(msg, session.ip, session.port);
            }
          }
        } catch (err) {}
      }
    }, 1500);

    this.socket.on('error', (err) => {
      console.error('[Transfer] Socket error:', err.message);
      this.emit('error', err);
    });

    this.socket.on('message', (msg, rinfo) => {
      this._handleRaw(msg, rinfo);
    });

    this.socket.bind(PORTS.DESKTOP, () => {
      console.log(`[Transfer] Listening on port ${PORTS.DESKTOP}`);
    });
  }

  stop() {
    if (this.socket) {
      
      for (const [sessionId, session] of this.sessions.entries()) {
        try {
          const buf = Buffer.from(buildDisconnect(sessionId), 'utf8');
          this.socket.send(buf, 0, buf.length, session.port, session.ip);
          console.log(`[Transfer] Sent DISCONNECT to session ${sessionId} before stopping`);
        } catch (_) {}
      }
      
      const sock = this.socket;
      setTimeout(() => { try { sock.close(); } catch (_) {} }, 100);
      this.socket = null;
    }
    this.sessions.clear();
  }

  setSaveDir(dir) {
    this.saveDir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  getSaveDir() {
    return this.saveDir;
  }

  setAllowControl(allow) {
    this.allowControl = allow;
    
    for (const [sessionId, session] of this.sessions.entries()) {
      this._send(`SILO_CTRL_ALLOW|${sessionId}|${allow}`, session.ip, session.port);
    }
  }

  pairDevice(deviceIP, devicePort, desktopName, pin) {
    return new Promise((resolve, reject) => {
      const sessionId = crypto.randomUUID();
      const msg = buildPairReq(sessionId, desktopName, pin, PORTS.DESKTOP);

      this._send(msg, deviceIP, devicePort);
      console.log(`[Transfer] Pairing request sent to ${deviceIP}:${devicePort} (session ${sessionId})`);

      const retryInterval = setInterval(() => {
        if (!this._pendingPairReqs.has(sessionId)) { clearInterval(retryInterval); return; }
        this._send(msg, deviceIP, devicePort);
        console.log(`[Transfer] Pairing re-send to ${deviceIP}:${devicePort} (session ${sessionId})`);
      }, 5000);

      const timer = setTimeout(() => {
        clearInterval(retryInterval);
        this._pendingPairReqs.delete(sessionId);
        reject(new Error('Pairing timed out — did you enter the code on the phone?'));
      }, 90000);  

      this._pendingPairReqs.set(sessionId, { resolve, reject, timer, retryInterval });
    });
  }

  async sendFile(filePath, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No active session: ${sessionId}`);

    const stats    = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const fileSize = stats.size;
    const fileId   = crypto.randomUUID().slice(0, 8);
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE) || 1;

    const key = `${sessionId}:${fileId}`;

    const startMsg = buildTransferStart(sessionId, fileId, fileName, fileSize, totalChunks, '');
    this._send(startMsg, session.ip, session.port);

    await this._waitForEvent(`xfer-ack:${key}`, 8000);

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);

    try {
      for (let i = 0; i < totalChunks; ) {
        
        const windowEnd = Math.min(i + WINDOW_SIZE, totalChunks);
        const ackSet = new Set();

        const windowPromises = [];
        for (let c = i; c < windowEnd; c++) {
          windowPromises.push(this._sendChunkWithRetry(fd, sessionId, fileId, c, totalChunks, session, ackSet));
        }

        await Promise.all(windowPromises);
        i = windowEnd;

        const progress = Math.round((i / totalChunks) * 100);
        this.emit('transfer-progress', { sessionId, fileId, fileName, progress, bytesSent: Math.min(i * CHUNK_SIZE, fileSize), totalBytes: fileSize });
      }
    } finally {
      fs.closeSync(fd);
    }

    const doneMsg = buildDone(sessionId, fileId);
    this._send(doneMsg, session.ip, session.port);

    this.emit('transfer-complete', { sessionId, fileId, fileName, fileSize, direction: 'send' });
    console.log(`[Transfer] Sent ${fileName} (${fileSize} bytes) via session ${sessionId}`);
  }

  disconnectSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this._send(buildDisconnect(sessionId), session.ip, session.port);
      this.sessions.delete(sessionId);
      this.emit('device-disconnected', { sessionId });
    }
  }

  _send(msgStr, ip, port) {
    if (!this.socket) return;
    const buf = Buffer.isBuffer(msgStr) ? msgStr : Buffer.from(msgStr, 'utf8');
    this.socket.send(buf, 0, buf.length, port, ip, (err) => {
      if (err) console.warn(`[Transfer] Send error to ${ip}:${port}:`, err.message);
    });
  }

  _handleRaw(buf, rinfo) {
    
    const camPrefix = 'SILO_CAM_FRAME|';
    const screenPrefix = 'SILO_SCREEN_FRAME|';
    const camPrefixBuf = Buffer.from(camPrefix, 'utf8');
    const screenPrefixBuf = Buffer.from(screenPrefix, 'utf8');
    
    if (
      (buf.length > camPrefixBuf.length && buf.slice(0, camPrefixBuf.length).equals(camPrefixBuf)) ||
      (buf.length > screenPrefixBuf.length && buf.slice(0, screenPrefixBuf.length).equals(screenPrefixBuf))
    ) {
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx !== -1) {
        const headerStr = buf.slice(0, newlineIdx).toString('utf8');
        const parts = headerStr.split('|');
        if (parts[0] === MSG.CAMERA_FRAME) {
          const rotation = parseInt(parts[1]) || 0;
          const jpegData = buf.slice(newlineIdx + 1);
          const base64 = jpegData.toString('base64');
          this.emit('camera-frame', { base64, rotation, raw: jpegData });
          return;
        }

        if (parts[0] === MSG.SCREEN_FRAME) {
          const rotation = parseInt(parts[1]) || 0;
          const jpegData = buf.slice(newlineIdx + 1);
          const base64 = jpegData.toString('base64');
          this.emit('screen-frame', { base64, rotation, raw: jpegData });
          return;
        }
      }
    }

    const chunk = parseChunkPacket(buf);
    if (chunk) {
      this._handleChunk(chunk, rinfo);
      return;
    }

    const ackNack = parseAckNack(buf);
    if (ackNack) {
      this.emit(`chunk-ack:${ackNack.sessionId}:${ackNack.fileId}:${ackNack.chunkIndex}`, ackNack);
      return;
    }

    const parsed = parseMessage(buf);
    if (!parsed) return;

    switch (parsed.type) {
      case MSG.PAIR_ACK:
        this._handlePairAck(parsed, rinfo);
        break;
      case MSG.PAIR_DENY:
        this._handlePairDeny(parsed, rinfo);
        break;
      case MSG.TRANSFER_START:
        this._handleTransferStart(parsed, rinfo);
        break;
      case MSG.TRANSFER_ACK:
        this.emit(`xfer-ack:${parsed.sessionId}:${parsed.fileId}`, parsed);
        break;
      case MSG.DONE:
        this._handleDone(parsed, rinfo);
        break;
      case MSG.CANCEL:
        this._handleCancel(parsed);
        break;
      case MSG.PING:
        this._handlePing(parsed, rinfo);
        break;
      case MSG.PONG:
        this._handlePong(parsed);
        break;
      case MSG.DISCONNECT:
        this._handleDisconnect(parsed);
        break;
      case MSG.MOUSE_MOVE:
        this.emit('mouse-move', parsed);
        break;
      case MSG.MOUSE_CLICK:
        this.emit('mouse-click', parsed);
        break;
      case MSG.KEYBOARD_INPUT:
        this.emit('keyboard-input', parsed);
        break;
      case MSG.CLIPBOARD_SYNC:
        if (this.allowControl) {
          try {
            const text = Buffer.from(parsed.parts[1], 'base64').toString('utf8');
            console.log(`[Clipboard] Received from Android: ${text.length} chars`);
            if (text !== this._lastClipboardText) {
              this._lastClipboardText = text;
              clipboard.writeText(text);
              console.log(`[Clipboard] Desktop clipboard updated!`);
            }
          } catch (e) {
            console.error(`[Clipboard] Error decoding:`, e);
          }
        }
        break;
      default:
        
    }
  }

  _handlePairAck(parsed, rinfo) {
    const { sessionId } = parsed;
    const pending = this._pendingPairReqs.get(sessionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    clearInterval(pending.retryInterval);
    this._pendingPairReqs.delete(sessionId);

    const session = { ip: rinfo.address, port: PORTS.ANDROID, sessionId, lastPing: Date.now() };
    this.sessions.set(sessionId, session);

    console.log(`[Transfer] Paired! Session ${sessionId} with ${rinfo.address}`);
    this.emit('device-connected', { sessionId, ip: rinfo.address, port: PORTS.ANDROID });

    this._send(`SILO_CTRL_ALLOW|${sessionId}|${this.allowControl}`, rinfo.address, PORTS.ANDROID);
    
    pending.resolve(sessionId);

    this._startKeepalive(sessionId);
  }

  _handlePairDeny(parsed, rinfo) {
    const { sessionId, reason } = parsed;
    const pending = this._pendingPairReqs.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    clearInterval(pending.retryInterval);
    this._pendingPairReqs.delete(sessionId);
    console.log(`[Transfer] Pairing denied (${reason}) from ${rinfo.address}`);
    pending.reject(new Error(reason === 'wrong_pin' ? 'Incorrect PIN' : 'Pairing rejected by device'));
  }

  _handleTransferStart(parsed, rinfo) {
    const { sessionId, fileId, fileName, fileSize, totalChunks, mimeType } = parsed;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const key = `${sessionId}:${fileId}`;
    const outPath = path.join(this.saveDir, this._safeFilename(fileName));

    this._inboundTransfers.set(key, {
      sessionId, fileId, fileName, fileSize, totalChunks, mimeType,
      receivedChunks: new Map(),   
      outputPath: outPath,
      startTime: Date.now(),
    });

    console.log(`[Transfer] Incoming: ${fileName} (${totalChunks} chunks) from ${rinfo.address}`);
    this.emit('transfer-incoming', { sessionId, fileId, fileName, fileSize, totalChunks });

    const ack = buildTransferAck(sessionId, fileId);
    this._send(ack, session.ip, session.port);
  }

  _handleChunk(chunk, rinfo) {
    const { sessionId, fileId, chunkIndex, totalChunks, data } = chunk;
    const key = `${sessionId}:${fileId}`;
    const transfer = this._inboundTransfers.get(key);
    if (!transfer) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    transfer.receivedChunks.set(chunkIndex, Buffer.from(data));

    const ack = buildChunkAck(sessionId, fileId, chunkIndex);
    this._send(ack, session.ip, session.port);

    const progress = Math.round((transfer.receivedChunks.size / transfer.totalChunks) * 100);
    this.emit('transfer-progress', {
      sessionId, fileId,
      fileName:   transfer.fileName,
      progress,
      bytesReceived: transfer.receivedChunks.size * CHUNK_SIZE,
      totalBytes:    transfer.fileSize,
      direction:     'receive',
    });
  }

  _handleDone(parsed, rinfo) {
    const { sessionId, fileId } = parsed;
    const key = `${sessionId}:${fileId}`;
    const transfer = this._inboundTransfers.get(key);
    if (!transfer) return;

    this._inboundTransfers.delete(key);

    const missing = [];
    for (let i = 0; i < transfer.totalChunks; i++) {
      if (!transfer.receivedChunks.has(i)) missing.push(i);
    }

    if (missing.length > 0) {
      console.warn(`[Transfer] Missing ${missing.length} chunks for ${transfer.fileName}`);
      
      const session = this.sessions.get(sessionId);
      if (session) {
        for (const idx of missing) {
          const nack = buildChunkNack(sessionId, fileId, idx);
          this._send(nack, session.ip, session.port);
        }
      }
      return;
    }

    this._assembleFile(transfer);
  }

  _handleCancel(parsed) {
    const key = `${parsed.sessionId}:${parsed.fileId}`;
    this._inboundTransfers.delete(key);
    this._outboundTransfers.delete(key);
    this.emit('transfer-cancelled', { sessionId: parsed.sessionId, fileId: parsed.fileId });
  }

  _handlePing(parsed, rinfo) {
    const session = this.sessions.get(parsed.sessionId);
    if (!session) return;
    session.lastPing = Date.now();
    
    this._send(buildPong(parsed.sessionId), session.ip, PORTS.ANDROID);
  }

  _handlePong(parsed) {
    const session = this.sessions.get(parsed.sessionId);
    if (session) session.lastPing = Date.now();
  }

  _handleDisconnect(parsed) {
    const session = this.sessions.get(parsed.sessionId);
    if (session) {
      this.sessions.delete(parsed.sessionId);
      this.emit('device-disconnected', { sessionId: parsed.sessionId });
      console.log(`[Transfer] Device disconnected: session ${parsed.sessionId}`);
    }
  }

  _startKeepalive(sessionId) {
    const interval = setInterval(() => {
      const session = this.sessions.get(sessionId);
      if (!session) { clearInterval(interval); return; }

      if (Date.now() - session.lastPing > SESSION_TIMEOUT_MS) {
        clearInterval(interval);
        this.sessions.delete(sessionId);
        this.emit('device-disconnected', { sessionId });
        console.log(`[Transfer] Session ${sessionId} timed out`);
        return;
      }

      this._send(buildPing(sessionId), session.ip, session.port);
    }, 2000);
  }

  async _sendChunkWithRetry(fd, sessionId, fileId, chunkIndex, totalChunks, session, ackSet) {
    const offset = chunkIndex * CHUNK_SIZE;
    const chunkBuf = Buffer.allocUnsafe(CHUNK_SIZE);
    const bytesRead = fs.readSync(fd, chunkBuf, 0, CHUNK_SIZE, offset);
    const data = chunkBuf.slice(0, bytesRead);
    const packet = buildChunkPacket(sessionId, fileId, chunkIndex, totalChunks, data);

    const ackKey = `chunk-ack:${sessionId}:${fileId}:${chunkIndex}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      this._send(packet, session.ip, session.port);

      try {
        await this._waitForEvent(ackKey, ACK_TIMEOUT_MS);
        ackSet.add(chunkIndex);
        return;
      } catch (_) {
        
        console.warn(`[Transfer] Chunk ${chunkIndex} timeout, retry ${attempt + 1}`);
      }
    }

    throw new Error(`Failed to deliver chunk ${chunkIndex} after ${MAX_RETRIES} retries`);
  }

  _waitForEvent(eventName, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(eventName, handler);
        reject(new Error(`Timeout waiting for ${eventName}`));
      }, timeoutMs);

      const handler = (data) => {
        clearTimeout(timer);
        resolve(data);
      };

      this.once(eventName, handler);
    });
  }

  _assembleFile(transfer) {
    const { outputPath, fileName, fileSize, totalChunks, receivedChunks, sessionId, fileId } = transfer;

    const finalPath = this._uniquePath(outputPath);

    const ws = fs.createWriteStream(finalPath);
    for (let i = 0; i < totalChunks; i++) {
      const chunk = receivedChunks.get(i);
      if (chunk) ws.write(chunk);
    }
    ws.end(() => {
      console.log(`[Transfer] Saved: ${finalPath}`);
      this.emit('transfer-complete', {
        sessionId, fileId, fileName, fileSize,
        savedPath: finalPath,
        direction: 'receive',
      });
    });
  }

  _safeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  }

  _uniquePath(p) {
    if (!fs.existsSync(p)) return p;
    const ext  = path.extname(p);
    const base = path.basename(p, ext);
    const dir  = path.dirname(p);
    let n = 1;
    let candidate;
    do { candidate = path.join(dir, `${base} (${n++})${ext}`); } while (fs.existsSync(candidate));
    return candidate;
  }
}

module.exports = TransferManager;
