/**
 * 端到端验证：用订阅里真实的 vless+ws+sstp 节点，走一遍
 *   本地 → Cloudflare 边缘 → edgetunnel Worker → SSTP 住宅节点 → 目标
 * 看拿到的出口 IP 是不是住宅 IP。
 *
 * 不依赖任何第三方库：手写 WebSocket 握手 + VLESS 帧。
 *
 * 用法: node test/e2e-vless.mjs "vless://...."
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { connectTcp, tlsUpgrade, parseProxy } from '../src/http.mjs';

const PROXY = parseProxy(process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897');
const link = process.argv[2] || (await import('node:fs')).readFileSync('logs/sub.txt', 'utf8');
let raw = String(link).trim();
if (!raw.startsWith('vless://')) raw = Buffer.from(raw, 'base64').toString('utf8');
const first = raw.split(/\r?\n/).find((l) => l.startsWith('vless://'));
const url = new URL(first);

const UUID = url.username;
const HOST = url.hostname;
const PORT = Number(url.port || 443);
const params = url.searchParams;
const SNI = params.get('sni') || HOST;
const WSPATH = params.get('path') || '/';
const WS_HOST = params.get('host') || HOST;
const LABEL = decodeURIComponent(url.hash.slice(1));

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

log(`节点: ${LABEL}`);
log(`入口: ${HOST}:${PORT}  SNI=${SNI}  WS-Host=${WS_HOST}`);
log(`路径: ${WSPATH.slice(0, 60)}${WSPATH.length > 60 ? '…' : ''}`);

/* ---------- 1) TCP + TLS ---------- */
const t0 = Date.now();
const rawSock = await connectTcp(HOST, PORT, PROXY, 20000);
const sock = await tlsUpgrade(rawSock, SNI, 20000);
log(`TLS 就绪 ${Date.now() - t0}ms  ALPN=${sock.alpnProtocol || '(none)'}`);

/* ---------- 2) WebSocket 握手 ---------- */
const key = crypto.randomBytes(16).toString('base64');
const handshake =
  `GET ${WSPATH} HTTP/1.1\r\n` +
  `Host: ${WS_HOST}\r\n` +
  `Upgrade: websocket\r\n` +
  `Connection: Upgrade\r\n` +
  `Sec-WebSocket-Key: ${key}\r\n` +
  `Sec-WebSocket-Version: 13\r\n` +
  `User-Agent: Mozilla/5.0\r\n\r\n`;
sock.write(handshake, 'latin1');

let buf = Buffer.alloc(0);
const waitFor = (predicate, ms, what) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} 超时 (${ms}ms)`)), ms);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const r = predicate();
      if (r) { clearTimeout(timer); sock.off('data', onData); resolve(r); }
    };
    sock.on('data', onData);
    const r = predicate();
    if (r) { clearTimeout(timer); sock.off('data', onData); resolve(r); }
  });

const head = await waitFor(() => {
  const i = buf.indexOf('\r\n\r\n');
  return i === -1 ? null : buf.subarray(0, i).toString('latin1');
}, 20000, 'WebSocket 握手');
buf = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
const status = head.split('\r\n')[0];
if (!/101/.test(status)) throw new Error(`WebSocket 升级失败: ${status}`);
const expectAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
if (!head.includes(expectAccept)) throw new Error('Sec-WebSocket-Accept 校验失败');
log(`WebSocket 已升级 ${Date.now() - t0}ms`);

/* ---------- 3) 发送 VLESS 请求头（目标 1.1.1.1:80） ---------- */
function wsFrame(payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x82, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x82; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x82; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

const uuidBytes = Buffer.from(UUID.replace(/-/g, ''), 'hex');
const TARGET_HOST = '1.1.1.1';
const TARGET_PORT = 80;
const vlessHeader = Buffer.concat([
  Buffer.from([0x00]),          // version
  uuidBytes,                     // 16 bytes
  Buffer.from([0x00]),          // addon length
  Buffer.from([0x01]),          // command: TCP
  Buffer.from([TARGET_PORT >> 8, TARGET_PORT & 0xff]),
  Buffer.from([0x01]),          // addr type: IPv4
  Buffer.from(TARGET_HOST.split('.').map(Number)),
]);
sock.write(wsFrame(Buffer.concat([
  vlessHeader,
  Buffer.from(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: 1.1.1.1\r\nUser-Agent: ip-auto-e2e\r\nConnection: close\r\n\r\n`, 'latin1'),
])));

/* ---------- 4) 读回 WS 帧 ---------- */
function* parseFrames() {
  for (;;) {
    if (buf.length < 2) return;
    const fin = (buf[0] & 0x80) !== 0;
    const op = buf[0] & 0x0f;
    let off = 2, len = buf[1] & 0x7f;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    yield { fin, op, payload };
  }
}

let text = '';
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  for (const f of parseFrames()) {
    if (f.op === 0x8) { log('服务端关闭 WebSocket'); break; }
    if (f.op === 0x1 || f.op === 0x2 || f.op === 0x0) text += f.payload.toString('utf8');
  }
  if (/ip=/.test(text) || /<\/html>/.test(text)) break;
  await new Promise((r) => setTimeout(r, 120));
}
sock.destroy();

/* ---------- 5) 结果 ---------- */
log(`总耗时 ${Date.now() - t0}ms  收到 ${text.length} 字节`);
const exitIp = (text.match(/^ip=(\S+)$/m) || [])[1];
const colo = (text.match(/^colo=(\S+)$/m) || [])[1];
const loc = (text.match(/^loc=(\S+)$/m) || [])[1];
if (!exitIp) {
  console.error('未拿到出口 IP，原始响应：');
  console.error(text.slice(0, 600));
  process.exit(1);
}
console.log(`\n出口 IP : ${exitIp}`);
console.log(`colo    : ${colo || '?'}    loc: ${loc || '?'}`);
console.log(`节点    : ${LABEL}`);
