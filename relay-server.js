// Minimal local WebSocket broadcast relay, implemented with only Node's
// built-in 'http'/'crypto' (no npm dependency — avoids network installs in
// environments where that has been unreliable). It exists purely so the app
// already expects it can find it: js/panel/BSP_display.html connects to
// ws://127.0.0.1:5511 whenever it's embedded outside the app's own managed
// Output window (e.g. added directly as an OBS Browser Source), and
// js/panel/remote-show-tools.js's broadcastMessage() already publishes every
// sync message there too (see shouldKeepRelayConnected() — it auto-connects
// whenever running inside this desktop shell). Without a server listening,
// that connection just refuses and nothing embedded that way ever syncs.
//
// Protocol: every message is a JSON envelope; the relay doesn't need to
// understand it — it just rebroadcasts whatever text one client sends to
// every connected client (including the sender, which already filters out
// its own echo via envelope.senderId).
const http = require('http');
const crypto = require('crypto');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024; // 8MB safety cap per message

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function createRelayServer(port, { log = () => {} } = {}) {
  const clients = new Set();

  function broadcast(payload) {
    const frame = encodeFrame(payload, 0x1);
    for (const client of clients) {
      if (client.destroyed) { clients.delete(client); continue; }
      try { client.write(frame); } catch (e) { /* dropped, non-fatal */ }
    }
  }

  const httpServer = http.createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade required (BSP relay)');
  });

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    let acceptKey;
    try {
      acceptKey = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    } catch (e) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );
    socket.setNoDelay(true);
    clients.add(socket);
    log(`client connected (${clients.size} total)`);

    let buffer = Buffer.alloc(0);

    function processBuffered() {
      for (;;) {
        if (buffer.length < 2) return;
        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buffer.length < offset + 2) return;
          payloadLen = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLen === 127) {
          if (buffer.length < offset + 8) return;
          payloadLen = Number(buffer.readBigUInt64BE(offset));
          offset += 8;
        }
        if (payloadLen > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
        let maskKey = null;
        if (masked) {
          if (buffer.length < offset + 4) return;
          maskKey = buffer.slice(offset, offset + 4);
          offset += 4;
        }
        if (buffer.length < offset + payloadLen) return;
        let payload = buffer.slice(offset, offset + payloadLen);
        if (masked) {
          const unmasked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
          payload = unmasked;
        }
        buffer = buffer.slice(offset + payloadLen);

        if (opcode === 0x8) { // close
          try { socket.end(); } catch (e) {}
          return;
        } else if (opcode === 0x9) { // ping -> pong
          try { socket.write(encodeFrame(payload, 0xA)); } catch (e) {}
        } else if ((opcode === 0x1 || opcode === 0x2) && fin) {
          // Small JSON control envelopes only — no fragmentation expected in
          // practice, so a non-final frame is simply dropped rather than
          // reassembled, keeping this implementation small and robust.
          broadcast(payload);
        }
      }
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try { processBuffered(); } catch (e) { log('frame parse error: ' + e.message); socket.destroy(); }
    });
    socket.on('close', () => {
      clients.delete(socket);
      log(`client disconnected (${clients.size} total)`);
    });
    socket.on('error', () => { clients.delete(socket); });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      log('relay listening on 127.0.0.1:' + port);
      resolve({
        port,
        close: () => new Promise((res) => {
          for (const client of clients) { try { client.destroy(); } catch (e) {} }
          clients.clear();
          httpServer.close(() => res());
        })
      });
    });
  });
}

module.exports = { createRelayServer };
