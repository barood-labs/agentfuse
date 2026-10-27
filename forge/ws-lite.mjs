// Minimal WebSocket server (RFC6455) — zero deps, demo-grade.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encode(data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buf, onMessage) {
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (pos + 2 > buf.length) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + len > buf.length) break;
    let payload = buf.subarray(pos + maskLen, pos + maskLen + len);
    if (masked) {
      const mask = buf.subarray(pos, pos + 4);
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    }
    offset = pos + maskLen + len;
    if (opcode === 0x8) return { closed: true, rest: buf.subarray(offset) };
    if (opcode === 0x1 || opcode === 0x2) onMessage(payload.toString('utf8'));
  }
  return { closed: false, rest: buf.subarray(offset) };
}

export function attachWebSocketServer(server, { path = '/ws' } = {}) {
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ].join('\r\n');
    socket.write(headers);
    if (head?.length) socket.unshift(head);

    const client = {
      send(data) {
        try {
          socket.write(encode(data));
        } catch {
          /* ignore */
        }
      },
      close() {
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      },
    };
    clients.add(client);

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const r = decodeFrames(buf, () => {});
      buf = r.rest;
      if (r.closed) {
        clients.delete(client);
        socket.end();
      }
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  return {
    broadcast(msg) {
      const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
      for (const c of clients) c.send(data);
    },
    get size() {
      return clients.size;
    },
  };
}
