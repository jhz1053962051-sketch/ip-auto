/**
 * 进程内 SOCKS5 → TLS → HTTP 客户端。
 *
 * 为什么不用 curl：
 *   本机（以及一些受管环境）里的 `curl.exe` 会被外层拦截层接管，**忽略 `-x` / `--socks5-hostname`**。
 *   实测：`curl --socks5-hostname 127.0.0.1:9`（一个根本不存在的端口）照样返回 200 ——
 *   也就是说 curl 报出来的"隧道延迟"其实是拦截层自己那条路的延迟，跟隧道毫无关系。
 *   曾经因此得出「中位 431ms、最快 151ms」的假结论；用本模块在进程内自己握手，
 *   同一个节点真值是 **3.0~3.6s**（TLS 握手那一步就包含了 SSTP 建链）。
 *
 * 所以：凡是"经过代理测延迟/测出口"的地方，都必须用这里的实现，不要 shell 出去调 curl。
 */
import net from 'node:net';
import tls from 'node:tls';

/** 和 xray 的 socks inbound 握手，CONNECT 到 host:port */
export function socks5Connect(port, host, dstPort, { timeoutMs = 15000, localAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, localAddress);
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = (m) => { s.destroy(); reject(new Error(m)); };
    const timer = setTimeout(() => fail('socks 握手超时'), timeoutMs);
    s.on('error', (e) => { clearTimeout(timer); fail(`socks 连接失败：${e.message}`); });
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(`socks 认证失败（${buf[1]}）`);
        buf = buf.subarray(2);
        const hb = Buffer.from(host, 'utf8');
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([dstPort >> 8, dstPort & 255])]));
        stage = 1;
        return;
      }
      if (buf.length < 5) return;
      if (buf[1] !== 0) return fail(`socks CONNECT 被拒（rep=${buf[1]}）`);
      const atyp = buf[3];
      let skip = 4;
      if (atyp === 1) skip += 4;
      else if (atyp === 3) skip += 1 + buf[4];
      else skip += 16;
      skip += 2;
      if (buf.length < skip) return;
      const rest = buf.subarray(skip);
      clearTimeout(timer);
      s.removeAllListeners('data');
      resolve({ socket: s, rest });
    });
  });
}

function tlsOver(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
    const timer = setTimeout(() => { t.destroy(); reject(new Error('TLS 握手超时')); }, timeoutMs);
    t.once('secureConnect', () => { clearTimeout(timer); resolve(t); });
    t.once('error', (e) => { clearTimeout(timer); reject(new Error(`TLS 失败：${e.message}`)); });
  });
}

/**
 * 经 socks5 代理发一个 HTTP/1.1 GET，返回分段耗时与响应体。
 * ttfb_ms = 从发起连接到收到第一块响应体的时间（含隧道建链 + TLS + 请求往返）—— 这才是用户体感。
 */
export async function socksHttpGet(port, host, path = '/', {
  timeoutMs = 25000,
  headers = {},
  secure = true,
} = {}) {
  const t0 = Date.now();
  const dstPort = secure ? 443 : 80;
  const { socket, rest } = await socks5Connect(port, host, dstPort, { timeoutMs });

  let conn = socket;
  if (secure) conn = await tlsOver(socket, host, timeoutMs);
  const tTls = Date.now() - t0;

  const hdrs = { Host: host, Connection: 'close', 'User-Agent': 'ip-auto-probe', Accept: '*/*', ...headers };
  conn.write(`GET ${path} HTTP/1.1\r\n${Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);

  const chunks = [];
  if (rest && rest.length) chunks.push(rest);
  let ttfb = null;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { conn.destroy(); resolve(); }, timeoutMs);
    conn.on('data', (d) => {
      if (ttfb === null) ttfb = Date.now() - t0;
      chunks.push(d);
    });
    conn.once('end', () => { clearTimeout(timer); resolve(); });
    conn.once('close', () => { clearTimeout(timer); resolve(); });
    conn.once('error', (e) => { clearTimeout(timer); reject(new Error(`隧道内请求失败：${e.message}`)); });
  });

  const text = Buffer.concat(chunks).toString('utf8');
  const i = text.indexOf('\r\n\r\n');
  const head = i >= 0 ? text.slice(0, i) : text;
  const body = i >= 0 ? text.slice(i + 4) : '';
  const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) || [])[1] || 0);
  return {
    status,
    body,
    ttfb_ms: ttfb ?? Date.now() - t0,
    tls_ms: tTls,
    total_ms: Date.now() - t0,
  };
}

/** 解析 cloudflare /cdn-cgi/trace 的 key=value */
export function parseTrace(body) {
  const out = {};
  for (const line of String(body).split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}