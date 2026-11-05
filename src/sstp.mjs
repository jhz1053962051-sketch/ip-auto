/**
 * SSTP / PPP 客户端（Node 无依赖实现）
 *
 * 协议：HTTP_DUPLEX_POST 升级 → SSTP 控制包 → PPP LCP → PAP → IPCP → PPP 上的 TCP/IP
 * 设计参考 GPLv3 项目 lsh8848/cm-Workers-CheckSocks5 的实现思路，为 node:net / node:tls 重写。
 */
import crypto from 'node:crypto';
import { connectTcp, tlsUpgrade } from './http.mjs';

const EMPTY = Buffer.alloc(0);
const u16 = (b, o = 0) => (b[o] << 8) | b[o + 1];

/* ------------------------------------------------------------------ */
/* 字节读取器                                                          */
/* ------------------------------------------------------------------ */
export class SocketReader {
  constructor(socket) {
    this.buf = EMPTY;
    this.ended = false;
    this.error = null;
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this._pump();
    });
    socket.on('end', () => { this.ended = true; this._pump(); });
    socket.on('close', () => { this.ended = true; this._pump(); });
    socket.on('error', (e) => { this.error = e; this._pump(); });
  }

  _pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      const enough = w.n === null ? this.buf.length > 0 : this.buf.length >= w.n;
      if (!enough && !this.ended && !this.error) break;
      this.waiters.shift();
      clearTimeout(w.timer);
      if (this.error) { w.reject(this.error); continue; }
      if (!enough) { w.reject(new Error('连接已被对端关闭')); continue; }
      w.resolve();
    }
  }

  _wait(n, timeoutMs) {
    if (this.error) return Promise.reject(this.error);
    const enough = n === null ? this.buf.length > 0 : this.buf.length >= n;
    if (enough) return Promise.resolve();
    if (this.ended) return Promise.reject(new Error('连接已被对端关闭'));
    return new Promise((resolve, reject) => {
      const w = { n, resolve, reject };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error('读取超时'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  async read(n, timeoutMs = 20000) {
    await this._wait(n, timeoutMs);
    if (this.buf.length < n) throw new Error('连接已被对端关闭');
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readLine(timeoutMs = 20000) {
    for (;;) {
      const idx = this.buf.indexOf(0x0a);
      if (idx !== -1) {
        const line = this.buf.subarray(0, idx).toString('latin1');
        this.buf = this.buf.subarray(idx + 1);
        return line.replace(/\r$/, '');
      }
      if (this.buf.length > 65536) throw new Error('响应头过长');
      await this._wait(null, timeoutMs);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 组包                                                                */
/* ------------------------------------------------------------------ */
export function buildSstpControlPacket(messageType, attributes = []) {
  const attrLen = attributes.reduce((s, a) => s + 4 + a.data.length, 0);
  const b = Buffer.alloc(8 + attrLen);
  b[0] = 0x10;
  b[1] = 0x01;
  b.writeUInt16BE((8 + attrLen) | 0x8000, 2);
  b.writeUInt16BE(messageType, 4);
  b.writeUInt16BE(attributes.length, 6);
  let o = 8;
  for (const a of attributes) {
    b[o + 1] = a.id;
    b.writeUInt16BE(4 + a.data.length, o + 2);
    a.data.copy(b, o + 4);
    o += 4 + a.data.length;
  }
  return b;
}

export function buildSstpDataPacket(pppFrame) {
  const l = 6 + pppFrame.length;
  const b = Buffer.alloc(l);
  b.set([0x10, 0x00, ((l >> 8) & 0x0f) | 0x80, l & 0xff, 0xff, 0x03], 0);
  pppFrame.copy(b, 6);
  return b;
}

export function buildPppConfigure(protocol, code, id, options = []) {
  const ol = options.reduce((s, o) => s + 2 + o.data.length, 0);
  const b = Buffer.alloc(6 + ol);
  b.writeUInt16BE(protocol, 0);
  b[2] = code;
  b[3] = id;
  b.writeUInt16BE(4 + ol, 4);
  let o = 6;
  for (const op of options) {
    b[o] = op.type;
    b[o + 1] = 2 + op.data.length;
    op.data.copy(b, o + 2);
    o += 2 + op.data.length;
  }
  return b;
}

function buildPapRequest(id, user = 'vpn', pass = 'vpn') {
  const u = Buffer.from(user);
  const pw = Buffer.from(pass);
  const pl = 6 + u.length + pw.length;
  const b = Buffer.alloc(2 + pl);
  b.writeUInt16BE(0xc023, 0);
  b[2] = 1;
  b[3] = id;
  b.writeUInt16BE(pl, 4);
  b[6] = u.length;
  u.copy(b, 7);
  b[7 + u.length] = pw.length;
  pw.copy(b, 8 + u.length);
  return b;
}

function parsePppOptions(payload) {
  const out = [];
  let o = 0;
  while (o + 2 <= payload.length) {
    const type = payload[o];
    const len = payload[o + 1];
    if (len < 2) break;
    out.push({ type, data: payload.subarray(o + 2, o + len) });
    o += len;
  }
  return out;
}

export function parsePppFrame(data) {
  const off = data.length >= 2 && data[0] === 0xff && data[1] === 0x03 ? 2 : 0;
  if (data.length - off < 2) return null;
  const protocol = u16(data, off);
  if (protocol === 0x0021) return { protocol, ipPacket: data.subarray(off + 2) };
  if (data.length - off < 6) return null;
  return {
    protocol,
    code: data[off + 2],
    id: data[off + 3],
    payload: data.subarray(off + 6),
    raw: data.subarray(off),
  };
}

/* ------------------------------------------------------------------ */
/* 隧道建立                                                            */
/* ------------------------------------------------------------------ */
/**
 * @param {{host:string, port?:number, proxy?:object, user?:string, pass?:string, timeoutMs?:number}} o
 * @returns {Promise<{assignedIp:string, write:Function, readPacket:Function, close:Function, reader:SocketReader}>}
 */
export async function sstpEstablish(o) {
  const { host, port = 443, proxy = null, user = 'vpn', pass = 'vpn', timeoutMs = 25000 } = o;

  const raw = await connectTcp(host, port, proxy, timeoutMs);
  const socket = await tlsUpgrade(raw, host, timeoutMs);
  const reader = new SocketReader(socket);
  const write = (buf) => new Promise((res, rej) => socket.write(buf, (e) => (e ? rej(e) : res())));

  const readPacket = async (t = timeoutMs) => {
    const header = await reader.read(4, t);
    const isControl = (header[1] & 1) !== 0;
    const length = u16(header, 2) & 0x0fff;
    if (length < 4) throw new Error('SSTP 包长度非法');
    const body = length > 4 ? await reader.read(length - 4, t) : EMPTY;
    return { isControl, body };
  };

  let pppId = 2;
  const hostHeader = Number(port) === 443 ? host : `${host}:${port}`;
  await write(Buffer.from(
    'SSTP_DUPLEX_POST /sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/ HTTP/1.1\r\n'
    + `Host: ${hostHeader}\r\n`
    + 'Content-Length: 18446744073709551615\r\n'
    + `SSTPCORRELATIONID: {${crypto.randomUUID()}}\r\n\r\n`,
    'latin1',
  ));

  // 1) 读 HTTP 响应头
  const statusLine = await reader.readLine(timeoutMs);
  for (;;) {
    if ((await reader.readLine(timeoutMs)) === '') break;
  }
  if (!/HTTP\/\d(?:\.\d)?\s+2\d\d/i.test(statusLine)) {
    throw new Error(`SSTP HTTP 握手失败: ${statusLine || '无状态行'}`);
  }

  // 2) 发 SSTP 控制包 + LCP Configure-Request
  const encap = Buffer.alloc(2);
  encap.writeUInt16BE(1, 0);
  await write(Buffer.concat([
    buildSstpControlPacket(0x0001, [{ id: 1, data: encap }]),
    buildSstpDataPacket(buildPppConfigure(0xc021, 1, pppId++, [{ type: 1, data: Buffer.from([0x05, 0xdc]) }])),
  ]));

  // 3) PPP 协商
  let localAcked = false;
  let peerAcked = false;
  let papSent = false;
  let papDone = false;
  let ipcpSent = false;
  let assignedIp = null;
  let ipcpAcked = false;

  const maybePap = async () => {
    if (!localAcked || !peerAcked || papSent) return;
    papSent = true;
    await write(buildSstpDataPacket(buildPapRequest(pppId++, user, pass)));
  };
  const maybeIpcp = async (suggested) => {
    if (!localAcked || !peerAcked || !papDone || ipcpSent) return;
    ipcpSent = true;
    const addr = suggested || Buffer.alloc(4);
    await write(buildSstpDataPacket(buildPppConfigure(0x8021, 1, pppId++, [{ type: 3, data: addr }])));
  };

  for (let round = 0; round < 80 && !(assignedIp && ipcpAcked); round++) {
    const packet = await readPacket(timeoutMs);
    if (packet.isControl) continue;
    const ppp = parsePppFrame(packet.body);
    if (!ppp) continue;

    if (ppp.protocol === 0xc021) {
      if (ppp.code === 1) {
        const ack = Buffer.from(ppp.raw);
        ack[2] = 2;
        await write(buildSstpDataPacket(ack));
        peerAcked = true;
        await maybePap();
        await maybeIpcp();
      } else if (ppp.code === 2) {
        localAcked = true;
        await maybePap();
        if (papDone) await maybeIpcp();
      }
    } else if (ppp.protocol === 0xc023) {
      if (ppp.code === 2) { papDone = true; await maybeIpcp(); }
      else if (ppp.code === 3) throw new Error('SSTP PAP 认证被拒绝');
    } else if (ppp.protocol === 0x8021) {
      if (ppp.code === 1) {
        const ack = Buffer.from(ppp.raw);
        ack[2] = 2;
        await write(buildSstpDataPacket(ack));
      } else if (ppp.code === 3) {
        // Configure-Nak：服务器建议地址，用它重发 Configure-Request
        const opt = parsePppOptions(ppp.payload).find((x) => x.type === 3);
        if (opt?.data?.length === 4) {
          assignedIp = [...opt.data].join('.');
          await write(buildSstpDataPacket(buildPppConfigure(0x8021, 1, pppId++, [{ type: 3, data: opt.data }])));
        }
      } else if (ppp.code === 2) {
        const opt = parsePppOptions(ppp.payload).find((x) => x.type === 3);
        if (opt?.data?.length === 4) assignedIp = [...opt.data].join('.');
        ipcpAcked = true;
      }
    }
  }

  if (!assignedIp) throw new Error('SSTP 未分配 IPv4 地址');

  return {
    assignedIp,
    write,
    readPacket,
    reader,
    close: () => { try { socket.destroy(); } catch {} },
  };
}

/* ------------------------------------------------------------------ */
/* PPP 之上跑 TCP                                                      */
/* ------------------------------------------------------------------ */
const ipToBytes = (ip) => Buffer.from(String(ip).split('.').map(Number));

function checksum(bytes, offset, length) {
  let sum = 0;
  for (let i = offset; i < offset + length - 1; i += 2) sum += u16(bytes, i);
  if (length & 1) sum += bytes[offset + length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

export function createTcpOverPpp(sstp, sourceIp, destIp) {
  const sourcePort = 20000 + crypto.randomInt(40000);
  let seq = crypto.randomBytes(4).readUInt32BE(0);
  let ack = 0;
  let destPort = 80;

  const ipHeader = Buffer.alloc(20);
  Buffer.from([0x45, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 64, 6]).copy(ipHeader, 0);
  ipToBytes(sourceIp).copy(ipHeader, 12);
  ipToBytes(destIp).copy(ipHeader, 16);

  const pseudo = Buffer.alloc(1500);
  ipToBytes(sourceIp).copy(pseudo, 0);
  ipToBytes(destIp).copy(pseudo, 4);
  pseudo[9] = 6;

  const buildFrame = (flags, payload = EMPTY) => {
    const tcpLen = 20 + payload.length;
    const ipLen = 20 + tcpLen;
    const total = 8 + ipLen;
    const frame = Buffer.alloc(total);
    Buffer.from([0x10, 0x00, ((total >> 8) & 0x0f) | 0x80, total & 0xff, 0xff, 0x03, 0x00, 0x21]).copy(frame, 0);
    ipHeader.copy(frame, 8);
    frame.writeUInt16BE(ipLen, 10);
    frame.writeUInt16BE(crypto.randomBytes(2).readUInt16BE(0), 12);
    frame.writeUInt16BE(checksum(frame, 8, 20), 18);

    frame.writeUInt16BE(sourcePort, 28);
    frame.writeUInt16BE(destPort, 30);
    frame.writeUInt32BE(seq, 32);
    frame.writeUInt32BE(ack, 36);
    frame[40] = 0x50;
    frame[41] = flags;
    frame.writeUInt16BE(65535, 42);
    if (payload.length) payload.copy(frame, 48);

    pseudo[10] = tcpLen >> 8;
    pseudo[11] = tcpLen & 0xff;
    frame.copy(pseudo, 12, 28, 28 + tcpLen);
    frame.writeUInt16BE(checksum(pseudo, 0, 12 + tcpLen), 44);
    return frame;
  };

  const matchIncoming = (ip) => {
    if (ip.length < 40 || ip[9] !== 6) return null;
    const ihl = (ip[0] & 0x0f) * 4;
    if (ip.length < ihl + 20) return null;
    if (u16(ip, ihl) !== destPort) return null;
    if (u16(ip, ihl + 2) !== sourcePort) return null;
    return {
      flags: ip[ihl + 13],
      sequence: ip.readUInt32BE(ihl + 4),
      payloadOffset: ihl + ((ip[ihl + 12] >> 4) & 0x0f) * 4,
    };
  };

  const handshake = async (port, timeoutMs = 20000) => {
    destPort = port;
    await sstp.write(buildFrame(0x02));
    seq = (seq + 1) >>> 0;
    for (let i = 0; i < 40; i++) {
      const packet = await sstp.readPacket(timeoutMs);
      if (packet.isControl) continue;
      const ppp = parsePppFrame(packet.body);
      if (!ppp || ppp.protocol !== 0x0021) continue;
      const tcp = matchIncoming(ppp.ipPacket);
      if (!tcp || (tcp.flags & 0x12) !== 0x12) continue;
      ack = (tcp.sequence + 1) >>> 0;
      await sstp.write(buildFrame(0x10));
      return;
    }
    throw new Error('隧道内 TCP 握手超时');
  };

  return {
    buildFrame,
    matchIncoming,
    handshake,
    get seq() { return seq; },
    set seq(v) { seq = v >>> 0; },
    get ack() { return ack; },
    set ack(v) { ack = v >>> 0; },
  };
}

/**
 * 在隧道内发一个 HTTP/1.1 请求并读回完整响应体。
 */
export async function httpOverSstp({ sstp, tcp, targetHost, path = '/', timeoutMs = 25000, maxBytes = 65536 }) {
  const reqBuf = Buffer.from([
    `GET ${path} HTTP/1.1`,
    `Host: ${targetHost}`,
    'User-Agent: Mozilla/5.0 (compatible; ip-auto/1.0)',
    'Accept: application/json',
    'Connection: close',
    '',
    '',
  ].join('\r\n'), 'latin1');

  await sstp.write(tcp.buildFrame(0x18, reqBuf));
  tcp.seq = (tcp.seq + reqBuf.length) >>> 0;

  const parts = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  let sawFin = false;

  while (Date.now() < deadline && total < maxBytes && !sawFin) {
    let packet;
    try {
      packet = await sstp.readPacket(Math.max(1000, deadline - Date.now()));
    } catch (e) {
      if (parts.length) break;
      throw e;
    }
    if (packet.isControl) continue;
    const ppp = parsePppFrame(packet.body);
    if (!ppp || ppp.protocol !== 0x0021) continue;
    const inc = tcp.matchIncoming(ppp.ipPacket);
    if (!inc) continue;

    if (inc.payloadOffset < ppp.ipPacket.length) {
      const payload = ppp.ipPacket.subarray(inc.payloadOffset);
      if (payload.length) {
        parts.push(Buffer.from(payload));
        total += payload.length;
        tcp.ack = (inc.sequence + payload.length) >>> 0;
        await sstp.write(tcp.buildFrame(0x10));
      }
    }
    if ((inc.flags & 0x01) !== 0) {
      tcp.ack = (tcp.ack + 1) >>> 0;
      sawFin = true;
      try { await sstp.write(tcp.buildFrame(0x11)); } catch {}
    }
  }

  const raw = Buffer.concat(parts).toString('utf8');
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) throw new Error('隧道内响应不完整');
  const head = raw.slice(0, headerEnd);
  const statusLine = head.split('\r\n')[0] || '';
  const m = statusLine.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  const status = m ? Number(m[1]) : 0;

  let body = raw.slice(headerEnd + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    let cur = 0;
    let out = '';
    while (cur < body.length) {
      const e = body.indexOf('\r\n', cur);
      if (e === -1) break;
      const size = parseInt(body.slice(cur, e).split(';')[0].trim(), 16);
      if (!Number.isFinite(size)) break;
      cur = e + 2;
      if (size === 0) break;
      out += body.slice(cur, cur + size);
      cur += size + 2;
    }
    body = out || body;
  }
  const clMatch = head.match(/\r\ncontent-length:\s*(\d+)/i);
  if (clMatch) body = body.slice(0, Number(clMatch[1]));

  return { status, statusLine, head, body, raw };
}
