// Minimal RFC-6455 WebSocket server (stdlib only): handshake, text frames,
// ping/pong, and close handling. Enough for the viewer's live feed.
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function isWsRequest(req) {
  const url = new URL(req.url, 'http://localhost');
  return url.pathname === '/ws' && (req.headers.upgrade || '').toLowerCase() === 'websocket';
}

export function acceptUpgrade(req, socket, onClient, onClose, { authToken = '' } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  if (authToken) {
    const url = new URL(req.url, 'http://localhost');
    const header = req.headers.authorization || '';
    const provided = url.searchParams.get('access_token')
      || (header.startsWith('Bearer ') ? header.slice(7) : '');
    if (provided !== authToken) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
      );
      socket.destroy();
      return null;
    }
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const client = { socket, alive: true };
  socket.on('data', buf => parseClientFrames(client, buf));
  socket.on('close', () => {
    client.alive = false;
    if (onClose) onClose(client);
  });
  socket.on('error', () => {
    client.alive = false;
  });
  if (onClient) onClient(client);
  return client;
}

function frame(opcode, payload) {
  let header;
  const len = payload.length;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
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

export function send(client, text) {
  if (!client || !client.alive) return;
  try {
    client.socket.write(frame(0x1, Buffer.from(String(text))));
  } catch {
    /* socket already closing */
  }
}

function parseClientFrames(client, buf) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (off + 4 > buf.length) return;
      len = buf.readUInt16BE(off + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (off + 10 > buf.length) return;
      len = Number(buf.readBigUInt64BE(off + 2));
      headerLen = 10;
    }
    const masked = (b1 & 0x80) !== 0;
    let payloadStart = off + headerLen;
    let maskKey = null;
    if (masked) {
      if (off + headerLen + 4 > buf.length) return;
      maskKey = buf.subarray(payloadStart, payloadStart + 4);
      payloadStart += 4;
    }
    if (payloadStart + len > buf.length) return; // need more bytes
    let payload = buf.subarray(payloadStart, payloadStart + len);
    if (masked && maskKey) {
      const unmasked = Buffer.from(payload);
      for (let i = 0; i < unmasked.length; i += 1) unmasked[i] ^= maskKey[i & 3];
      payload = unmasked;
    }
    if (opcode === 0x9) {
      // ping -> pong (echo payload)
      try { client.socket.write(frame(0xa, payload)); } catch { /* ignore */ }
    } else if (opcode === 0x8) {
      try { client.socket.end(); } catch { /* ignore */ }
      return;
    }
    off = payloadStart + len;
  }
}
