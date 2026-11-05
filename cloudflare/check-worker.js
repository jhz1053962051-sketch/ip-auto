/**
 * Cloudflare Worker —— SSTP 节点单点探测（单文件 · 零依赖 · ESM）
 *
 * ============================ 部署方式 ============================
 * Cloudflare Dashboard → Workers & Pages → 创建 → Worker → 「编辑代码」→
 * 把本文件全部内容粘贴进去 → 部署。部署后打开 https://<worker>.workers.dev/
 * 会看到一个自检页（含示例链接），点一下就能验证隧道是否打通。
 * 不需要 KV、不需要 Durable Object、不需要 wrangler.toml。
 * ==================================================================
 *
 * 用法：
 *   GET /check?sstp=vpn:vpn@HOST:443
 *   GET /check?host=HOST&port=443
 *   GET /check?sstp=vpn:vpn@HOST:443&timeout=30000&probe=1.2.3.4:80
 *   GET /check?socks5=HOST:1080      → 返回 unsupported type: socks5
 *
 * 本文件是 C:\Users\J1053\Documents\ip-auto\src\sstp.mjs（475 行）+
 * src\probe.mjs（100 行）的 Worker 移植。协议细节（握手顺序、包结构、
 * 校验和算法、往返判定）严格照抄 Node 实现，只替换运行时原语：
 *   node:net / node:tls  →  cloudflare:sockets 的 connect()
 *   Buffer               →  Uint8Array + DataView 式手工读写
 *   socket.on('data')    →  socket.readable.getReader() 拉流 + 内部缓冲
 *
 * 和 Node 版的差异只在「探测端点」这一层：Worker 里没法做 DNS 解析，
 * 所以隧道内的 TCP 必须直接用 IP 建连（详见 PROBE_CHAIN 注释）。
 */

import { connect } from 'cloudflare:sockets';

/* ================================================================== */
/* 常量                                                                */
/* ================================================================== */

const EMPTY = new Uint8Array(0);

/** SSTP 的 SRA 升级路径（MS-SSTP 固定值，一个字符都不能改） */
const SSTP_SRA_PATH = '/sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/';

/** 默认整条链路预算（毫秒）与上限 */
const DEFAULT_TIMEOUT_MS = 25000;
const MAX_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 2000;

/** PPP 协议号 */
const PPP_LCP = 0xc021;
const PPP_PAP = 0xc023;
const PPP_IPCP = 0x8021;
const PPP_IPV4 = 0x0021;

/** PPP 控制码 */
const PPP_CONF_REQ = 1;
const PPP_CONF_ACK = 2;
const PPP_CONF_NAK = 3;

/** TCP 标志位 */
const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;

/**
 * 隧道内探测端点候选链。
 *
 * 为什么不能像 Node 版那样解析 api.ipify.org 再连：
 *   Worker 里没有 dns 模块，connect() 只接受 hostname，若直接连域名，
 *   域名解析发生在「Cloudflare 边缘 → 目标」，而不是「隧道出口 → 目标」，
 *   那样拿到的就不是 VPN 的出口 IP 了，整个探测失去意义。
 * 所以我们自己在隧道内做 TCP，目标必须是一个**字面 IP**。
 *
 * 首选 1.1.1.1 的 /cdn-cgi/trace：返回纯文本，其中 `ip=` 行就是
 * Cloudflare 看到的对端地址，也就是这条隧道的真实出口 IP，不需要 DNS。
 * 后面的 api.ipify.org 走「IP 直连 + Host 头写域名」的经典做法
 * （明文 HTTP/80，没有 TLS，所以不存在 SNI 问题）。
 */
const PROBE_CHAIN = [
  { host: '1.1.1.1', ip: '1.1.1.1', port: 80, path: '/cdn-cgi/trace', accept: 'text/plain' },
  { host: 'api.ipify.org', ip: '104.26.10.209', port: 80, path: '/?format=json', accept: 'application/json' },
  { host: 'api.ipify.org', ip: '104.26.11.209', port: 80, path: '/?format=json', accept: 'application/json' },
  { host: 'api.ipify.org', ip: '172.67.74.209', port: 80, path: '/?format=json', accept: 'application/json' },
];

/** 严格 IPv4 点分十进制 */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * 内网 / 保留 / 非公网段（探针拿到这些就说明隧道没通到公网，不能算可用）。
 * 前三段是任务要求的必查项，后面几段是同性质的补充：
 *   100.64/10 CGNAT、192.0.2/24 与 198.51.100/24 与 203.0.113/24 文档段、
 *   198.18/15 基准测试段、224/4 组播、240/4 保留。
 */
const NON_PUBLIC_RE =
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.2\.|198\.(18|19)\.|198\.51\.100\.|203\.0\.113\.|22[4-9]\.|2[3-5]\d\.)/;

/* ================================================================== */
/* 字节工具（Worker 没有 Buffer，全部手搓）                             */
/* ================================================================== */

const u16 = (b, o = 0) => (b[o] << 8) | b[o + 1];
const u32 = (b, o = 0) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function setU16(b, o, v) {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
}

function setU32(b, o, v) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

/** 拼接若干 Uint8Array（等价 Buffer.concat） */
function concat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * latin1 编码：HTTP 请求行/头必须逐字节原样发出，不能用 UTF-8
 * （非 ASCII 的主机名/用户名会变宽导致 Content-Length 与字节数不符）。
 */
function latin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function latin1String(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function utf8Bytes(s) {
  return utf8Encoder.encode(s);
}

function utf8String(b) {
  return utf8Decoder.decode(b);
}

function randU16() {
  return crypto.getRandomValues(new Uint8Array(2)).reduce((a, b) => (a << 8) | b, 0) & 0xffff;
}

function randU32() {
  return u32(crypto.getRandomValues(new Uint8Array(4)), 0);
}

function randPort() {
  // 20000~59999，避开常见服务端口，也避开低端口被运营商过滤的可能
  return 20000 + (randU32() % 40000);
}

/**
 * 给 Promise 套一个超时。计时器一定在 finally 里清掉（不泄漏）。
 * 落败的一方显式挂一个空 catch：避免 race 已经结束、原 Promise 稍后
 * 才 reject（比如 socket 关闭）时产生 unhandledRejection —— 在 Worker
 * 里未处理的拒绝会污染日志，甚至直接终止该请求。
 */
function withTimeout(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * 整条链路的预算。所有阶段都从这里取时间片，保证总耗时不会超过
 * ?timeout= 指定的值，而不是每步各自 25 秒叠加。
 */
class Budget {
  constructor(totalMs) {
    this.deadline = Date.now() + totalMs;
  }

  left() {
    return this.deadline - Date.now();
  }

  /** 取一个不超过 max 的时间片；已经耗尽就直接抛（让上层走结构化失败） */
  slice(max = Number.POSITIVE_INFINITY) {
    const l = this.left();
    if (l <= 0) throw new Error('整体超时：SSTP 探测未在限定时间内完成');
    return Math.min(l, max);
  }
}

/* ================================================================== */
/* 带缓冲的字节读取器                                                  */
/* ================================================================== */

/**
 * 对应 Node 版的 SocketReader，只是把「data 事件」换成了「后台拉流」。
 *
 * socket.readable 是一个 ReadableStream，只能有一个 reader；这里开一个
 * 后台循环把 chunk 累积进 buf，读方法只在 buf 不够长时挂一个 waiter。
 * 超时用 setTimeout + waiter 记录实现，命中/超时都会 splice 掉并
 * clearTimeout，不会留下悬空计时器。
 */
class ByteReader {
  constructor(socket) {
    this.reader = socket.readable.getReader();
    this.buf = EMPTY;
    this.eof = false;
    this.err = null;
    this.waiters = [];
    this._pump();
  }

  _pump() {
    // 后台拉流：一直读到 done 或异常。所有异常都内部消化，只记录不抛，
    // 否则这个游离的 async 函数会产生未处理的拒绝。
    (async () => {
      try {
        for (;;) {
          const r = await this.reader.read();
          if (r.done) break;
          const v = r.value;
          if (v && v.byteLength) {
            this.buf = concat(this.buf, v);
            this._notify();
          }
        }
      } catch (e) {
        this.err = e instanceof Error ? e : new Error(String(e));
      }
      this.eof = true;
      this._notify();
    })();
  }

  _notify() {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (this.buf.length >= w.n || this.err || this.eof) {
        this.waiters.splice(i, 1);
        if (w.timer !== null) clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  _wait(n, timeoutMs) {
    if (this.err) return Promise.reject(this.err);
    if (this.buf.length >= n) return Promise.resolve();
    if (this.eof) return Promise.reject(new Error('连接已被对端关闭'));
    return new Promise((resolve, reject) => {
      const w = { n, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error('读取超时'));
      }, Math.max(1, timeoutMs));
      this.waiters.push(w);
    });
  }

  async read(n, timeoutMs = 20000) {
    if (n === 0) return EMPTY;
    await this._wait(n, timeoutMs);
    if (this.buf.length < n) throw new Error('连接已被对端关闭');
    const out = this.buf.slice(0, n); // slice 复制，避免上层长期持有大缓冲
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readLine(timeoutMs = 20000) {
    for (;;) {
      const idx = this.buf.indexOf(0x0a);
      if (idx !== -1) {
        const line = latin1String(this.buf.subarray(0, idx));
        this.buf = this.buf.subarray(idx + 1);
        return line.replace(/\r$/, '');
      }
      if (this.buf.length > 65536) throw new Error('响应头过长');
      await this._wait(this.buf.length + 1, timeoutMs);
    }
  }

  /** 把字节塞回缓冲区头部（解析失败需要回退时用） */
  unread(bytes) {
    if (!bytes || !bytes.length) return;
    this.buf = concat(bytes, this.buf);
    this._notify();
  }

  close() {
    try {
      this.reader.cancel().catch(() => {});
    } catch {}
    try {
      this.reader.releaseLock();
    } catch {}
  }
}

/* ================================================================== */
/* 组包（逐字节对齐 src/sstp.mjs 的同名函数）                          */
/* ================================================================== */

/**
 * SSTP 控制包。
 * 头 4B：version=0x10, flags(bit0=1 表示控制包), length(bit15 恒 1 | 低 12 位长度)
 * 体 4B：messageType, attributeCount
 * 属性：Reserved(1B=0) + AttributeID(1B) + Length(2B) + Value
 */
function buildSstpControlPacket(messageType, attributes = []) {
  const attrLen = attributes.reduce((s, a) => s + 4 + a.data.length, 0);
  const b = new Uint8Array(8 + attrLen);
  b[0] = 0x10;
  b[1] = 0x01;
  setU16(b, 2, (8 + attrLen) | 0x8000);
  setU16(b, 4, messageType);
  setU16(b, 6, attributes.length);
  let o = 8;
  for (const a of attributes) {
    b[o + 1] = a.id;
    setU16(b, o + 2, 4 + a.data.length);
    b.set(a.data, o + 4);
    o += 4 + a.data.length;
  }
  return b;
}

/**
 * SSTP 数据包：4B 头 + 2B PPP 地址/控制字段 (ff 03) + PPP 帧。
 * 注意 flags 位是 0x00（数据包），长度同样带 0x8000 标记。
 */
function buildSstpDataPacket(pppFrame) {
  const l = 6 + pppFrame.length;
  const b = new Uint8Array(l);
  b.set([0x10, 0x00, ((l >> 8) & 0x0f) | 0x80, l & 0xff, 0xff, 0x03], 0);
  b.set(pppFrame, 6);
  return b;
}

/** PPP 控制包（LCP/IPCP 通用）：协议 2B + code + id + 长度 2B + 选项 */
function buildPppConfigure(protocol, code, id, options = []) {
  const ol = options.reduce((s, o) => s + 2 + o.data.length, 0);
  const b = new Uint8Array(6 + ol);
  setU16(b, 0, protocol);
  b[2] = code;
  b[3] = id;
  setU16(b, 4, 4 + ol);
  let o = 6;
  for (const op of options) {
    b[o] = op.type;
    b[o + 1] = 2 + op.data.length;
    b.set(op.data, o + 2);
    o += 2 + op.data.length;
  }
  return b;
}

/** PAP Authenticate-Request（code=1），长度字段含 code/id/长度本身 */
function buildPapRequest(id, user = 'vpn', pass = 'vpn') {
  const u = utf8Bytes(user);
  const pw = utf8Bytes(pass);
  const pl = 6 + u.length + pw.length;
  const b = new Uint8Array(2 + pl);
  setU16(b, 0, PPP_PAP);
  b[2] = 1;
  b[3] = id;
  setU16(b, 4, pl);
  b[6] = u.length;
  b.set(u, 7);
  b[7 + u.length] = pw.length;
  b.set(pw, 8 + u.length);
  return b;
}

/** 解析 PPP 选项串（type + len + data 序列） */
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

/**
 * 解析 SSTP 数据包里的 PPP 帧。
 * 先剥掉 ff 03（PPP Address/Control 字段）——服务器不一定带，所以要按需判断；
 * 回 Configure-Ack 时也必须用剥掉前缀后的 raw 重新组包，否则会多出 2 字节。
 */
function parsePppFrame(data) {
  const off = data.length >= 2 && data[0] === 0xff && data[1] === 0x03 ? 2 : 0;
  if (data.length - off < 2) return null;
  const protocol = u16(data, off);
  if (protocol === PPP_IPV4) return { protocol, ipPacket: data.subarray(off + 2) };
  if (data.length - off < 6) return null;
  return {
    protocol,
    code: data[off + 2],
    id: data[off + 3],
    payload: data.subarray(off + 6),
    raw: data.subarray(off),
  };
}

/* ================================================================== */
/* SSTP 隧道建立（严格照 src/sstp.mjs 的 sstpEstablish）               */
/* ================================================================== */

/**
 * @param {{host:string, port:number, user:string, pass:string}} node
 * @param {Budget} budget
 * @returns {Promise<{assignedIp:string, write:(u:Uint8Array)=>Promise<void>,
 *                    readPacket:(t:number)=>Promise<{isControl:boolean, body:Uint8Array}>,
 *                    reader:ByteReader, close:()=>void}>}
 */
async function sstpEstablish(node, budget) {
  const { host, port, user, pass } = node;

  /* ---------- 1) 建 TCP + TLS ----------
   * secureTransport: 'on' → 运行时替我们完成 TLS 握手（SSTP 必须走 TLS）。
   * hostname 传的是 IP 时不会发 SNI，这和 Node 版
   * `servername: net.isIP(servername) ? undefined : servername` 行为一致。
   */
  const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
  try {
    await withTimeout(socket.opened, budget.slice(12000), `连接 ${host}:${port} 超时`);
  } catch (e) {
    try {
      socket.close();
    } catch {}
    throw new Error(`建立 TLS 连接失败（${host}:${port}）：${e?.message || e}`);
  }

  const reader = new ByteReader(socket);
  const writer = socket.writable.getWriter();
  const write = async (u8) => {
    await writer.write(u8);
  };

  // 读一个 SSTP 包：4B 头（含长度）→ 剩余 length-4 字节
  const readPacket = async (t) => {
    const header = await reader.read(4, t);
    const isControl = (header[1] & 1) !== 0;
    const length = u16(header, 2) & 0x0fff;
    if (length < 4) {
      // 长度非法说明流已经错位，把 4 字节塞回去方便上层排查，然后报错
      reader.unread(header);
      throw new Error('SSTP 包长度非法');
    }
    const body = length > 4 ? await reader.read(length - 4, t) : EMPTY;
    return { isControl, body };
  };

  let pppId = 2;
  const hostHeader = Number(port) === 443 ? host : `${host}:${port}`;

  /* ---------- 2) 发 HTTP 升级请求 ----------
   * 三个字段缺一不可：
   *   - 请求行必须是 SSTP_DUPLEX_POST + SRA 路径（大小写与 GUID 都是协议常量）
   *   - Content-Length: 18446744073709551615 (2^64-1) 表示「无限长双工流」
   *   - SSTPCORRELATIONID 由服务端用来做会话关联，缺了部分实现会直接 400
   * 结尾必须是 CRLFCRLF，且这一包发完就停手。
   */
  await write(
    latin1Bytes(
      `SSTP_DUPLEX_POST ${SSTP_SRA_PATH} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        'Content-Length: 18446744073709551615\r\n' +
        `SSTPCORRELATIONID: {${crypto.randomUUID()}}\r\n` +
        '\r\n',
    ),
  );

  /* ---------- 3) 必须先把响应头读干净，再发 SSTP 包 ----------
   * 这是整个移植里最容易踩的坑：
   * 如果把「HTTP 升级请求」和「SSTP CALL_CONNECT_REQUEST」合并成一个 write，
   * 或者边读边发，很多 SSTP 服务端（SoftEther / MikroTik / Windows RRAS）
   * 会因为请求体边界还没确定而直接 ECONNRESET。
   * 正确顺序是：写完请求 → 逐行读到空行为止（读到最后一个 CRLFCRLF）→
   * 确认状态行是 2xx → 才允许往这条双工流里塞第一个 SSTP 包。
   */
  const statusLine = await reader.readLine(budget.slice(10000));
  for (;;) {
    const line = await reader.readLine(budget.slice(10000));
    if (line === '') break;
  }
  if (!/HTTP\/\d(?:\.\d)?\s+2\d\d/i.test(statusLine)) {
    throw new Error(`SSTP HTTP 握手失败: ${statusLine || '无状态行'}`);
  }

  /* ---------- 4) SSTP CALL_CONNECT_REQUEST + 首个 LCP Configure-Request ----------
   * 控制包 msg type 0x0001，属性 id=1（ENCAPSULATED_PROTOCOL_ID）长度 2
   * 值为 0x0001（PPP）。这一包之后紧跟 LCP Configure-Request（MRU 1500
   * = 0x05dc），两个包可以一起 write —— 因为此时 HTTP 头已经读完了。
   */
  const encap = new Uint8Array(2);
  setU16(encap, 0, 1);
  await write(
    concat(
      buildSstpControlPacket(0x0001, [{ id: 1, data: encap }]),
      buildSstpDataPacket(
        buildPppConfigure(PPP_LCP, PPP_CONF_REQ, pppId++, [{ type: 1, data: new Uint8Array([0x05, 0xdc]) }]),
      ),
    ),
  );

  /* ---------- 5) PPP 协商状态机 ----------
   * localAcked : 我们发的 Configure-Request 被服务器 Ack 了
   * peerAcked  : 服务器发的 Configure-Request 被我们 Ack 了
   * 两边都成立才允许进 PAP；PAP 成功后才允许进 IPCP。
   * 这几个顺序约束不能颠倒，否则服务端会直接丢包或者回 Terminate。
   */
  let localAcked = false;
  let peerAcked = false;
  let papSent = false;
  let papDone = false;
  let ipcpSent = false; // 幂等保护：IPCP Configure-Request 只发一次
  let ipcpNakRounds = 0; // Nak 重发次数上限，防死循环
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
    // 首次请求地址 0.0.0.0（「随便给我一个」），服务器会用 Configure-Nak 回建议地址
    const addr = suggested || new Uint8Array(4);
    await write(buildSstpDataPacket(buildPppConfigure(PPP_IPCP, PPP_CONF_REQ, pppId++, [{ type: 3, data: addr }])));
  };

  for (let round = 0; round < 80 && !(assignedIp && ipcpAcked); round++) {
    const packet = await readPacket(budget.slice(8000));
    if (packet.isControl) continue; // 控制包（比如 CALL_CONNECT_ACK）直接跳过
    const ppp = parsePppFrame(packet.body);
    if (!ppp) continue;

    if (ppp.protocol === PPP_LCP) {
      if (ppp.code === PPP_CONF_REQ) {
        // 回 Configure-Ack：raw 已经剥掉 ff 03，只把 code 从 1 改成 2，
        // buildSstpDataPacket 会重新补上 ff 03。
        const ack = new Uint8Array(ppp.raw);
        ack[2] = PPP_CONF_ACK;
        await write(buildSstpDataPacket(ack));
        peerAcked = true;
        await maybePap();
      } else if (ppp.code === PPP_CONF_ACK) {
        localAcked = true;
        await maybePap();
        if (papDone) await maybeIpcp();
      }
    } else if (ppp.protocol === PPP_PAP) {
      if (ppp.code === 2) {
        papDone = true;
        await maybeIpcp();
      } else if (ppp.code === 3) {
        throw new Error('SSTP PAP 认证被拒绝（用户名/密码不对）');
      }
    } else if (ppp.protocol === PPP_IPCP) {
      if (ppp.code === PPP_CONF_REQ) {
        const ack = new Uint8Array(ppp.raw);
        ack[2] = PPP_CONF_ACK;
        await write(buildSstpDataPacket(ack));
      } else if (ppp.code === PPP_CONF_NAK) {
        /* Configure-Nak 不是失败！
         * 服务器在说「0.0.0.0 不行，用这个地址」。取 option type=3（IP-Address）
         * 的 4 字节，用它重发 Configure-Request，然后等 code=2 才算完成。
         * 这里单独发、不走 maybeIpcp，是因为 maybeIpcp 的 ipcpSent 已经置位
         * （幂等保护），重发必须绕过它；同时用 ipcpNakRounds 兜住死循环。 */
        const opt = parsePppOptions(ppp.payload).find((x) => x.type === 3);
        if (opt?.data?.length === 4) {
          assignedIp = Array.from(opt.data).join('.');
          if (ipcpNakRounds++ >= 4) throw new Error('SSTP IPCP 反复 Nak，无法收敛');
          await write(buildSstpDataPacket(buildPppConfigure(PPP_IPCP, PPP_CONF_REQ, pppId++, [{ type: 3, data: opt.data }])));
        }
      } else if (ppp.code === PPP_CONF_ACK) {
        const opt = parsePppOptions(ppp.payload).find((x) => x.type === 3);
        if (opt?.data?.length === 4) assignedIp = Array.from(opt.data).join('.');
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
    close: () => {
      reader.close();
      try {
        writer.releaseLock();
      } catch {}
      try {
        socket.close();
      } catch {}
    },
  };
}

/* ================================================================== */
/* PPP 之上跑 TCP（照抄 createTcpOverPpp）                             */
/* ================================================================== */

const ipToBytes = (ip) => new Uint8Array(String(ip).split('.').map((x) => Number(x) & 0xff));

/** 反码求和校验（IP 头与 TCP 伪头共用） */
function checksum(bytes, offset, length) {
  let sum = 0;
  for (let i = offset; i < offset + length - 1; i += 2) sum += u16(bytes, i);
  if (length & 1) sum += bytes[offset + length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

/**
 * 在 SSTP 隧道里手工做一次 TCP 会话。
 * @param {object} sstp sstpEstablish 的返回值
 * @param {string} sourceIp 隧道分配的本地地址（IPCP 拿到的）
 * @param {string} destIp 目标字面 IP（不能是域名，Worker 里没有 DNS）
 */
function createTcpOverPpp(sstp, sourceIp, destIp) {
  const sourcePort = randPort();
  let seq = randU32();
  let ack = 0;
  let destPort = 80;

  // IP 头模板：版本 4 / IHL 5、TOS 0、总长（每帧回填）、标识（每帧随机）、
  // flags 0x40（DF）、TTL 64、协议 6（TCP）
  const ipHeader = new Uint8Array(20);
  ipHeader.set([0x45, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 64, 6]);
  ipHeader.set(ipToBytes(sourceIp), 12);
  ipHeader.set(ipToBytes(destIp), 16);

  /* TCP 校验和用的伪头：源 IP(4) + 目的 IP(4) + 0x00 + 0x06 + TCP 长度(2)，
   * 后面 12 字节偏移处接 TCP 头+载荷。缓冲区 1500 字节上限，
   * 也就是单帧最大 MSS ~1488，探测用的小请求足够。 */
  const pseudo = new Uint8Array(1500);
  pseudo.set(ipToBytes(sourceIp), 0);
  pseudo.set(ipToBytes(destIp), 4);
  pseudo[8] = 0x00;
  pseudo[9] = 6;

  const buildFrame = (flags, payload = EMPTY) => {
    const tcpLen = 20 + payload.length;
    const ipLen = 20 + tcpLen;
    const total = 8 + ipLen;
    const frame = new Uint8Array(total);
    // SSTP 数据头 + PPP 的 ff 03 + 0x0021(IPv4)
    frame.set([0x10, 0x00, ((total >> 8) & 0x0f) | 0x80, total & 0xff, 0xff, 0x03, 0x00, 0x21], 0);
    frame.set(ipHeader, 8);
    setU16(frame, 10, ipLen); // IP 总长
    setU16(frame, 12, randU16()); // IP 标识
    setU16(frame, 18, checksum(frame, 8, 20)); // IP 头校验和

    setU16(frame, 28, sourcePort);
    setU16(frame, 30, destPort);
    setU32(frame, 32, seq);
    setU32(frame, 36, ack);
    frame[40] = 0x50; // 数据偏移 5*4=20，无选项
    frame[41] = flags;
    setU16(frame, 42, 65535); // 窗口
    if (payload.length) frame.set(payload, 48);

    pseudo[10] = (tcpLen >> 8) & 0xff;
    pseudo[11] = tcpLen & 0xff;
    pseudo.set(frame.subarray(28, 28 + tcpLen), 12);
    setU16(frame, 44, checksum(pseudo, 0, 12 + tcpLen));
    return frame;
  };

  /** 判断收到的 IP 包是否属于本会话（端口都要对上），返回 TCP 关键字段 */
  const matchIncoming = (ip) => {
    if (ip.length < 40 || ip[9] !== 6) return null;
    const ihl = (ip[0] & 0x0f) * 4;
    if (ip.length < ihl + 20) return null;
    if (u16(ip, ihl) !== destPort) return null;
    if (u16(ip, ihl + 2) !== sourcePort) return null;
    return {
      flags: ip[ihl + 13],
      sequence: u32(ip, ihl + 4),
      payloadOffset: ihl + ((ip[ihl + 12] >> 4) & 0x0f) * 4,
    };
  };

  /** 三次握手：SYN → 等 SYN-ACK((flags & 0x12) === 0x12) → ACK */
  const handshake = async (port, timeoutMs = 20000) => {
    destPort = port;
    await sstp.write(buildFrame(TCP_SYN));
    seq = (seq + 1) >>> 0;
    for (let i = 0; i < 40; i++) {
      const packet = await sstp.readPacket(timeoutMs);
      if (packet.isControl) continue;
      const ppp = parsePppFrame(packet.body);
      if (!ppp || ppp.protocol !== PPP_IPV4) continue;
      const tcp = matchIncoming(ppp.ipPacket);
      if (!tcp || (tcp.flags & 0x12) !== 0x12) continue;
      ack = (tcp.sequence + 1) >>> 0;
      await sstp.write(buildFrame(TCP_ACK));
      return;
    }
    throw new Error('隧道内 TCP 握手超时（未收到 SYN-ACK）');
  };

  return {
    buildFrame,
    matchIncoming,
    handshake,
    get destPort() {
      return destPort;
    },
    get seq() {
      return seq;
    },
    set seq(v) {
      seq = v >>> 0;
    },
    get ack() {
      return ack;
    },
    set ack(v) {
      ack = v >>> 0;
    },
  };
}

/**
 * 在隧道内发一个 HTTP/1.1 请求并读回完整响应（照抄 httpOverSstp）。
 * 因为走的是自己拼的 TCP，没有 TLS，所以只能打 80 端口明文。
 */
async function httpOverSstp({ sstp, tcp, targetHost, path = '/', accept = 'application/json', budget, maxBytes = 65536 }) {
  const reqBuf = latin1Bytes(
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${targetHost}`,
      'User-Agent: Mozilla/5.0 (compatible; ip-auto-worker/1.0)',
      `Accept: ${accept}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'),
  );

  await sstp.write(tcp.buildFrame(TCP_PSH | TCP_ACK, reqBuf));
  tcp.seq = (tcp.seq + reqBuf.length) >>> 0;

  const parts = [];
  let total = 0;
  let sawFin = false;

  while (budget.left() > 0 && total < maxBytes && !sawFin) {
    let packet;
    try {
      packet = await sstp.readPacket(Math.max(1000, budget.slice(8000)));
    } catch (e) {
      // 已经收到部分响应就当作结束（服务端常常发完 FIN 就断，读会抛）
      if (parts.length) break;
      throw e;
    }
    if (packet.isControl) continue;
    const ppp = parsePppFrame(packet.body);
    if (!ppp || ppp.protocol !== PPP_IPV4) continue;
    const inc = tcp.matchIncoming(ppp.ipPacket);
    if (!inc) continue; // 别的流/乱序包，丢掉

    if (inc.payloadOffset < ppp.ipPacket.length) {
      const payload = ppp.ipPacket.subarray(inc.payloadOffset);
      if (payload.length) {
        parts.push(payload.slice());
        total += payload.length;
        tcp.ack = (inc.sequence + payload.length) >>> 0;
        await sstp.write(tcp.buildFrame(TCP_ACK));
      }
    }
    if ((inc.flags & TCP_FIN) !== 0) {
      tcp.ack = (tcp.ack + 1) >>> 0;
      sawFin = true;
      try {
        await sstp.write(tcp.buildFrame(TCP_FIN | TCP_ACK));
      } catch {}
    }
  }

  const raw = utf8String(concat(...parts));
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) throw new Error('隧道内响应不完整（未收到完整 HTTP 头）');
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

/* ================================================================== */
/* 出口 IP 解析与校验                                                  */
/* ================================================================== */

/**
 * 从探测响应里取出口 IP。
 * 优先按 trace 的 `ip=` 行解析（1.1.1.1/cdn-cgi/trace），
 * 不是 trace 就按 JSON 的 .ip 解析（api.ipify.org）。
 * 两条路都不通 → 明确的失败原因（运营商/热点劫持登录页是最常见的情况）。
 */
function extractExitIp(text) {
  const trace = /^ip=(.+)$/m.exec(text);
  if (trace) return { ip: trace[1].trim() };

  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { error: `探针返回非 JSON（疑似劫持页）: ${text.replace(/\s+/g, ' ').trim().slice(0, 40)}` };
  }
  if (!parsed || typeof parsed.ip !== 'string') {
    return { error: `探针 IP 非法: ${JSON.stringify(parsed).slice(0, 60)}` };
  }
  return { ip: parsed.ip };
}

/** 校验出口 IP 必须是合法公网 IPv4 */
function validateExitIp(ip) {
  if (!IPV4_RE.test(ip)) return `探针 IP 非法: ${ip}`;
  if (NON_PUBLIC_RE.test(ip)) return `探针拿到内网/保留地址: ${ip}`;
  return null;
}

/* ================================================================== */
/* 出口归属（ip-api.com，走普通 fetch，不经过隧道）                    */
/* ================================================================== */

const GEO_FIELDS = 'status,country,countryCode,isp,org,as,asname,hosting,proxy';

/**
 * 查出口 IP 的归属信息。
 * fetch 在 Worker 里可用，而且这条请求应该走 Cloudflare 自己的出网，
 * 不应该、也没法走隧道（隧道已经用完就关了）。
 * 拿不到就全部返回 null，但上层 success 仍为 true —— 探测本身是成功的，
 * 只是归属查询失败（ip-api 免费额度 45 次/分钟，很容易打满）。
 */
async function lookupExit(ip, timeoutMs = 6000) {
  const empty = { ip, country: null, country_code: null, asn: null, is_datacenter: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${GEO_FIELDS}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return empty;
    const data = await res.json();
    if (!data || data.status !== 'success') return empty;

    // as 字段形如 "AS10010 TOKAI Communications"，第一个词就是 ASN
    const asText = typeof data.as === 'string' ? data.as.trim() : '';
    const asnCode = asText ? asText.split(/\s+/)[0] : null;
    const asn = asnCode || data.org || data.asname
      ? { asn: asnCode || null, org: data.org ?? null, name: data.asname ?? null, type: null }
      : null;

    // hosting 只有明确的 true/false 才下结论，缺字段就给 null（未知）
    const isDatacenter = data.hosting === true ? true : data.hosting === false ? false : null;

    return {
      ip,
      country: data.country ?? null,
      country_code: data.countryCode ?? null,
      asn,
      is_datacenter: isDatacenter,
    };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/* ================================================================== */
/* 参数解析                                                            */
/* ================================================================== */

/** 兼容上游调用方的 5 种前缀参数；本 Worker 只实现 sstp */
const TYPE_PARAMS = ['sstp', 'socks5', 'http', 'https', 'turn'];

/** 解析 `vpn:vpn@host:port`（也接受 sstp:// 前缀、裸 host、[v6]:port） */
function parseSstpValue(value) {
  let s = String(value).trim().replace(/^sstp:\/\//i, '');
  let user = 'vpn';
  let pass = 'vpn';

  const at = s.lastIndexOf('@');
  if (at !== -1) {
    const auth = s.slice(0, at);
    s = s.slice(at + 1);
    const ci = auth.indexOf(':');
    if (ci === -1) user = auth;
    else {
      user = auth.slice(0, ci);
      pass = auth.slice(ci + 1);
    }
  }

  let host = '';
  let port = 443;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) {
    host = v6[1];
    port = Number(v6[2] || 443);
  } else {
    const i = s.lastIndexOf(':');
    if (i !== -1 && /^\d+$/.test(s.slice(i + 1))) {
      host = s.slice(0, i);
      port = Number(s.slice(i + 1));
    } else {
      host = s;
    }
  }
  return { host: host.trim(), port, user, pass };
}

/** 解析 ?probe=1.2.3.4:80（也接受 1.2.3.4:80/some/path 和纯 IP） */
function parseProbe(value) {
  let s = String(value).trim().replace(/^https?:\/\//i, '');
  let path = '';
  const slash = s.indexOf('/');
  if (slash !== -1) {
    path = s.slice(slash);
    s = s.slice(0, slash);
  }
  const i = s.lastIndexOf(':');
  if (i !== -1 && /^\d+$/.test(s.slice(i + 1))) {
    return { ip: s.slice(0, i), port: Number(s.slice(i + 1)), path: path || '/' };
  }
  return { ip: s, port: 80, path: path || '/' };
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

/**
 * 一次完整探测：SSTP 隧道 → 隧道内 TCP → 明文 HTTP → 出口 IP → 归属。
 * 任何阶段出错都收敛成结构化结果，不会往外抛。
 */
/** 校验类错误（隧道确实把流量送进了内网 / 探针返回了非法地址）——不重试 */
class FatalProbeError extends Error {}

async function probeSstp(node, opts) {
  const t0 = Date.now();
  const budget = new Budget(opts.timeoutMs);
  const targets = opts.targets;
  let sstp = null;
  let lastError = null;

  try {
    sstp = await sstpEstablish(node, budget);

    // 按候选链依次尝试。只有「传输层/解析层」失败才换下一个端点；
    // 一旦拿到了 IP 但校验不过（内网地址、劫持页），说明这是真实探测结果，
    // 直接失败，不要再换端点掩盖问题。
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const isLast = i === targets.length - 1;
      try {
        // 每个端点重新建一条 TCP 流（新源端口），避免复用到上一条流的残留状态
        const tcp = createTcpOverPpp(sstp, sstp.assignedIp, target.ip);
        await tcp.handshake(target.port, budget.slice(isLast ? budget.left() : 6000));

        const res = await httpOverSstp({
          sstp,
          tcp,
          targetHost: target.host,
          path: target.path,
          accept: target.accept || 'application/json',
          budget,
          maxBytes: 8192,
        });

        if (res.status < 200 || res.status >= 300) throw new Error(`探针 HTTP ${res.status}`);

        const pick = extractExitIp(res.body);
        if (pick.error) throw new Error(pick.error);

        const bad = validateExitIp(pick.ip);
        if (bad) throw new FatalProbeError(bad);

        return { exitIp: pick.ip, assignedIp: sstp.assignedIp, responseTime: Date.now() - t0 };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (err instanceof FatalProbeError) throw err;
        lastError = err;
      }
    }
    throw lastError || new Error('所有探测端点均失败');
  } finally {
    try {
      sstp?.close();
    } catch {}
  }
}

/** /check 的完整处理：解析参数 → 探测 → 归属 → 组装 JSON */
async function handleCheck(request, url) {
  const t0 = Date.now();
  const colo = (request.cf && request.cf.colo) || 'UNKNOWN';

  const fail = (type, rawValue, error) => ({
    success: false,
    type,
    rawValue,
    error,
    responseTime: Date.now() - t0,
    colo,
  });

  // ---- 1) 识别类型参数 ----
  let type = null;
  let raw = '';
  for (const t of TYPE_PARAMS) {
    const v = url.searchParams.get(t);
    if (v) {
      type = t;
      raw = v.trim();
      break;
    }
  }

  const hostParam = url.searchParams.get('host');
  if (!type) {
    if (hostParam) {
      type = 'sstp';
      raw = `${hostParam}:${url.searchParams.get('port') || 443}`;
    } else {
      return fail('sstp', '', '缺少 sstp 或 host 参数');
    }
  }

  if (type !== 'sstp') return fail(type, raw, `unsupported type: ${type}`);

  // ---- 2) 解析节点 ----
  let node;
  if (url.searchParams.get('sstp')) {
    node = parseSstpValue(raw);
  } else {
    node = {
      host: String(hostParam).trim(),
      port: Number(url.searchParams.get('port') || 443),
      user: url.searchParams.get('user') || 'vpn',
      pass: url.searchParams.get('pass') || 'vpn',
    };
  }

  const rawValue = `${node.host}:${node.port}`;
  if (!node.host) return fail('sstp', rawValue, '节点地址为空');
  if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    return fail('sstp', rawValue, `端口非法: ${node.port}`);
  }

  // ---- 3) 预算与探测端点 ----
  const wantTimeout = Number(url.searchParams.get('timeout') || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, Number.isFinite(wantTimeout) ? wantTimeout : DEFAULT_TIMEOUT_MS),
  );

  const probeParam = url.searchParams.get('probe');
  const probeHost = url.searchParams.get('probeHost');
  const probePath = url.searchParams.get('probePath');
  let targets;
  if (probeParam) {
    const p = parseProbe(probeParam);
    if (!IPV4_RE.test(p.ip)) {
      // connect() 在隧道外做 DNS，域名目标会解析到 Cloudflare 出口而不是 VPN 出口，
      // 那样测出来的 IP 毫无意义，所以这里直接把域名挡掉。
      return fail('sstp', rawValue, `probe 必须是字面 IPv4 地址: ${p.ip}`);
    }
    targets = [
      {
        ip: p.ip,
        port: p.port,
        path: probePath || p.path || '/',
        host: probeHost || p.ip,
        accept: 'text/plain, application/json',
      },
    ];
  } else {
    targets = PROBE_CHAIN;
  }

  // ---- 4) 探测 ----
  let result;
  try {
    result = await probeSstp(node, { timeoutMs, targets });
  } catch (e) {
    return fail('sstp', rawValue, e?.message || String(e));
  }

  // ---- 5) 归属信息（失败不影响 success） ----
  const exit = await lookupExit(result.exitIp, 6000);

  return {
    success: true,
    type: 'sstp',
    rawValue,
    responseTime: Date.now() - t0,
    colo,
    exit,
    assigned_ip: result.assignedIp,
  };
}

/* ================================================================== */
/* 自检页                                                              */
/* ================================================================== */

function renderIndex(request, url) {
  const origin = url.origin;
  const sample = `${origin}/check?sstp=vpn:vpn@YOUR_HOST:443`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SSTP 检测 Worker</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 760px; margin: 48px auto; padding: 0 20px; }
  h1 { font-size: 20px; }
  code, pre { background: rgba(127,127,127,.14); border-radius: 6px; }
  code { padding: 2px 5px; }
  pre { padding: 12px; overflow-x: auto; }
  li { margin: 6px 0; }
  .muted { opacity: .65; }
</style>
</head>
<body>
<h1>SSTP 检测 Worker</h1>
<p class="muted">单文件 Cloudflare Worker：SSTP / PPP / IPCP / 隧道内 TCP 全部手写，无依赖。</p>
<h2>用法</h2>
<ul>
  <li><a href="${sample}">${sample}</a></li>
  <li><a href="${origin}/check?host=YOUR_HOST&amp;port=443">${origin}/check?host=YOUR_HOST&amp;port=443</a></li>
  <li><a href="${origin}/check?sstp=vpn:vpn@YOUR_HOST:443&amp;timeout=30000">${origin}/check?sstp=vpn:vpn@YOUR_HOST:443&amp;timeout=30000</a></li>
</ul>
<h2>参数</h2>
<pre>sstp=vpn:vpn@host:port   # 用户名:密码@主机:端口（默认 vpn/vpn，端口默认 443）
host=1.2.3.4&amp;port=443    # 等价写法
timeout=25000            # 整条链路预算，上限 60000
probe=1.1.1.1:80         # 覆盖隧道内探测端点（必须是字面 IP）
probeHost=...            # 覆盖探测请求的 Host 头
probePath=/...           # 覆盖探测请求的 path
socks5= / http= / https= / turn=  # 仅为兼容上游调用方，返回 unsupported type</pre>
<h2>返回</h2>
<pre>{
  "success": true,
  "type": "sstp",
  "rawValue": "host:port",
  "responseTime": 2345,
  "colo": "NRT",
  "exit": {
    "ip": "1.2.3.4",
    "country": "Japan",
    "country_code": "JP",
    "asn": { "asn": "AS10010", "org": "TOKAI", "name": "TOKAI Communications", "type": null },
    "is_datacenter": false
  },
  "assigned_ip": "10.x.x.x"
}</pre>
<p class="muted">失败时返回 success:false + error，字段名与成功结构一致。</p>
</body>
</html>`;
}

/* ================================================================== */
/* 入口                                                                */
/* ================================================================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': '*',
      'cache-control': 'no-store',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/check') {
      // 无论成功失败都回 200 + JSON：上游调用方只看 body.success，
      // 用 4xx/5xx 反而会让一部分 HTTP 客户端直接抛错、拿不到 error 文案。
      let body;
      try {
        body = await handleCheck(request, url);
      } catch (e) {
        body = {
          success: false,
          type: 'sstp',
          rawValue: '',
          error: e?.message || String(e),
          responseTime: 0,
          colo: (request.cf && request.cf.colo) || 'UNKNOWN',
        };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(renderIndex(request, url), {
      status: 200,
      headers: { ...cors, 'content-type': 'text/html; charset=utf-8' },
    });
  },
};
