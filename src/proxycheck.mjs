/**
 * 通用代理探针：直连测试 socks5 / http / https 代理，取回出口 IP。
 *
 * 为什么需要它：
 *   VPN Gate 只提供 SSTP/OpenVPN/L2TP/WireGuard，且节点国家池有限（长期没有新加坡）。
 *   而 edgetunnel 的链式代理支持 socks5 / http / https / turn / sstp 五种，
 *   所以「补充国家」最省事的路径是接入公共代理池，用 socks5 或 http 作为链式代理。
 *
 * ## 探测路径必须和 edgetunnel 一致（踩过的坑）
 * 最早的实现让 http 代理直接发 absolute-form `GET http://ip-api.com/...`，
 * 这样会把「只支持 GET 转发、不支持 CONNECT 隧道」的代理判为可用。
 * 实测 `129.226.93.232:80` 本地 OK，线上 Worker 却返回
 * `Connection failed: HTTP 404` —— 因为 edgetunnel 的 `httpConnect()` 走的是
 * `CONNECT host:443` 建隧道，那台代理不支持 CONNECT。
 * 所以这里统一改成：**先 CONNECT 建隧道，再在隧道里发普通 GET**，
 * 与 `_worker.js` 的 admin/check 与 chain 分支完全一致。
 *
 * 注意：公共代理池的 IP 绝大多数是机房（hosting=true），真实住宅极少且存活时间短。
 * 本模块只负责连通性与出口 IP，归属判定交给 geo.mjs。
 */
import net from 'node:net';
import * as tlsMod from 'node:tls';

const IPAPI_FIELDS = 'status,country,countryCode,city,isp,org,as,asname,hosting,proxy,mobile,reverse,query';
/**
 * 探测目标：**必须和 edgetunnel 的 `admin/check` 完全一致** ——
 * `CONNECT cloudflare.com:443` → TLS → `GET /cdn-cgi/trace` → 取 `ip=` / `loc=`。
 *
 * 为什么不用 ip-api 的明文 80：实测公共代理绝大多数只放行 CONNECT 到 443，
 * 对 `CONNECT ip-api.com:80` 直接回 403/404（4.144.146.21 / 8.219.97.248 / 129.226.93.232 全中）。
 * 那些代理在线上 Worker 里其实可用（因为 Worker 连的是 443），
 * 用 80 探测会把好代理全判死。改成 443 后两边判定一致。
 * 归属信息（ASN/机房住宅）不再从这里拿，交给 geo.mjs 的批量查询。
 */
const PROBE_HOST = 'cloudflare.com';
const PROBE_PORT = 443;

/** 建到 host:port 的裸 TCP */
function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    socket.setNoDelay(true);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 读满一个 HTTP 响应（含头+体），用于代理返回 */
function readHttpResponse(socket, timeoutMs, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let headerEnd = -1;
    let contentLength = -1;
    let chunked = false;
    const timer = setTimeout(() => {
      socket.removeAllListeners('data');
      reject(new Error('代理响应超时'));
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      socket.removeAllListeners('data');
      resolve(buf);
    };

    const check = () => {
      if (headerEnd === -1) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) {
          if (buf.length > 16384) {
            clearTimeout(timer);
            reject(new Error('代理响应头过长'));
          }
          return;
        }
        headerEnd = i + 4;
        const head = buf.subarray(0, i).toString('latin1');
        const cl = /\r\ncontent-length:\s*(\d+)/i.exec(head);
        if (cl) contentLength = Number(cl[1]);
        chunked = /\r\ntransfer-encoding:\s*chunked/i.test(head);
      }
      if (contentLength >= 0 && buf.length >= headerEnd + contentLength) return finish();
      if (chunked && buf.subarray(headerEnd).includes('0\r\n\r\n')) return finish();
      if (buf.length > maxBytes) return finish();
    };

    socket.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      try {
        check();
      } catch (e) {
        reject(e);
      }
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(buf);
    });
  });
}

/** 解析 HTTP 响应 → {status, body} */
export function parseHttp(buf) {
  const i = buf.indexOf('\r\n\r\n');
  if (i === -1) throw new Error('响应缺少头部结束符');
  const head = buf.subarray(0, i).toString('latin1');
  const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head);
  if (!m) throw new Error(`无法解析响应行: ${head.split('\r\n')[0]}`);
  const status = Number(m[1]);
  let body = buf.subarray(i + 4);
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) body = dechunk(body);
  return { status, body };
}

function dechunk(buf) {
  const out = [];
  let p = 0;
  for (;;) {
    const nl = buf.indexOf('\r\n', p);
    if (nl === -1) break;
    const size = parseInt(buf.subarray(p, nl).toString('latin1').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.subarray(nl + 2, nl + 2 + size));
    p = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** 从 socket 精确读 n 字节（累计缓冲） */
function waitFor(socket, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('代理握手超时'));
    }, timeoutMs);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= n) {
        cleanup();
        resolve(buf);
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('代理在握手完成前关闭连接'));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
    }
    socket.on('data', onData);
    socket.once('error', onErr);
    socket.once('close', onClose);
  });
}

/** SOCKS5 握手 + CONNECT（支持域名/IPv4 目标，无认证或 user/pass 认证） */
async function socks5Connect(socket, targetHost, targetPort, timeoutMs, auth) {
  socket.write(Buffer.from([0x05, auth ? 0x02 : 0x01, 0x00, ...(auth ? [0x02] : [])]));
  const sel = await waitFor(socket, 2, timeoutMs);
  if (sel[0] !== 0x05) throw new Error('不是 SOCKS5 代理');
  const method = sel[1];
  if (method === 0x02) {
    if (!auth) throw new Error('代理要求认证但未提供用户名密码');
    const u = Buffer.from(auth.user || '', 'utf8');
    const p = Buffer.from(auth.pass || '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    const ar = await waitFor(socket, 2, timeoutMs);
    if (ar[1] !== 0x00) throw new Error('SOCKS5 认证失败');
  } else if (method !== 0x00) {
    throw new Error(`SOCKS5 不支持的认证方式 ${method}`);
  }

  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(targetHost);
  let addr;
  if (isIp) {
    addr = Buffer.from([0x01, ...targetHost.split('.').map(Number)]);
  } else {
    const h = Buffer.from(targetHost, 'utf8');
    addr = Buffer.concat([Buffer.from([0x03, h.length]), h]);
  }
  const portBuf = Buffer.from([targetPort >> 8, targetPort & 0xff]);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));

  const rep = await waitFor(socket, 4, timeoutMs);
  if (rep[1] !== 0x00) {
    const map = { 1: '服务器故障', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达', 5: '连接被拒', 6: 'TTL 过期', 7: '命令不支持', 8: '地址类型不支持' };
    throw new Error(`SOCKS5 CONNECT 失败: ${map[rep[1]] || `code ${rep[1]}`}`);
  }
  // 吞掉 BND.ADDR/BND.PORT
  const atyp = rep[3];
  const need = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : rep[4];
  const rest = await waitFor(socket, need + 2, timeoutMs);
  void rest;
  return socket;
}

/**
 * HTTP 代理 CONNECT 隧道（与 edgetunnel 的 `httpConnect()` 行为一致）。
 *
 * 请求：`CONNECT host:port HTTP/1.1\r\nHost: host:port\r\n[Proxy-Authorization]\r\n\r\n`
 * 成功：`HTTP/1.1 200 Connection Established`，之后这条 TCP 就是到目标的裸隧道。
 *
 * 为什么要挑 200：一部分代理返回 `200 Connection established`、有些是
 * `HTTP/1.0 200 OK`，还有只回 `HTTP/1.1 200`。只要状态码 200 就算通，
 * 其余（403/404/407/502）都意味着「这台代理不给我们开隧道」，直接判死。
 */
async function httpConnect(socket, targetHost, targetPort, timeoutMs, auth) {
  const hp = `${targetHost}:${targetPort}`;
  let head = `CONNECT ${hp} HTTP/1.1\r\nHost: ${hp}\r\nUser-Agent: curl/8\r\nProxy-Connection: Keep-Alive\r\n`;
  if (auth) {
    head += `Proxy-Authorization: Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}\r\n`;
  }
  socket.write(`${head}\r\n`);

  // 头可能跨多个包：用一次性的持续监听读齐 \r\n\r\n。
  // 不能用「读 1 字节再重挂监听」的写法 —— 两次挂载之间到达的数据会丢。
  const text = await readHeaders(socket, timeoutMs, 16384);
  const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(text);
  if (!m) throw new Error(`CONNECT 响应异常: ${text.split('\r\n')[0]}`);
  const status = Number(m[1]);
  if (status !== 200) throw new Error(`CONNECT 被拒绝: HTTP ${status}`);
  return socket;
}

/** 读到头部结束符为止，返回 latin1 文本（与 socket 解耦，只挂一次监听） */
function readHeaders(socket, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('CONNECT 响应超时'));
    }, timeoutMs);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.includes('\r\n\r\n') || buf.length >= maxBytes) {
        cleanup();
        resolve(buf.toString('latin1'));
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      resolve(buf.toString('latin1'));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
    }
    socket.on('data', onData);
    socket.once('error', onErr);
    socket.once('close', onClose);
  });
}

/** 在已建立的裸 TCP 上套 TLS（SNI = 目标域名），与 `tls.connect({socket})` 等价 */
function upgradeTls(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tls = tlsMod.connect({
      socket,
      servername,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false, // 只测连通性，不做证书校验（与 Worker 的 insecure:true 一致）
    });
    const timer = setTimeout(() => {
      tls.destroy();
      reject(new Error('隧道内 TLS 握手超时'));
    }, timeoutMs);
    tls.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(tls);
    });
    tls.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * 探测一个代理的连通性与出口 IP。
 * @param {{type:'socks5'|'http', host:string, port:number, user?:string, pass?:string}} proxy
 * @param {{timeoutMs?:number}} opt
 * @returns {Promise<{ok:boolean, type:string, host:string, port:number, exitIp?:string, responseTime:number, geo?:object, error?:string}>}
 */
export async function checkProxy(proxy, opt = {}) {
  const { timeoutMs = 8000 } = opt;
  const t0 = Date.now();
  const auth = proxy.user ? { user: proxy.user, pass: proxy.pass } : null;
  let socket = null;
  try {
    socket = await tcpConnect(proxy.host, proxy.port, timeoutMs);
    if (proxy.type === 'socks5') {
      await socks5Connect(socket, PROBE_HOST, PROBE_PORT, timeoutMs, auth);
    } else {
      await httpConnect(socket, PROBE_HOST, PROBE_PORT, timeoutMs, auth);
    }
    // 隧道建成后再套 TLS，和 Worker 里 `new TlsClient(tcpSocket, {serverName})` 一致
    const tls = await upgradeTls(socket, PROBE_HOST, timeoutMs);

    let trace = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdn-cgi/trace 超时')), timeoutMs + 4000);
      tls.on('data', (c) => {
        trace += c.toString('utf8');
        if (trace.includes('\nip=') || trace.length > 8192) {
          clearTimeout(timer);
          resolve();
        }
      });
      tls.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      tls.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      tls.write(
        `GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${PROBE_HOST}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`,
      );
    });

    const ipMatch = /(?:^|\n)ip=([0-9a-fA-F:.]+)/.exec(trace);
    if (!ipMatch) throw new Error(`trace 里没有 ip=（响应: ${trace.replace(/\s+/g, ' ').slice(0, 60)}）`);
    const exitIp = ipMatch[1].trim();
    const loc = /(?:^|\n)loc=([A-Z]{2})/.exec(trace)?.[1] || null;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(exitIp)) throw new Error(`trace 返回的 ip 非法: ${exitIp}`);
    tls.destroy();
    return {
      ok: true,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      user: proxy.user || null,
      pass: proxy.pass || null,
      exitIp,
      loc,
      responseTime: Date.now() - t0,
      geo: null,
    };
  } catch (error) {
    return {
      ok: false,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      user: proxy.user || null,
      pass: proxy.pass || null,
      error: error?.message || String(error),
      responseTime: Date.now() - t0,
    };
  } finally {
    try {
      socket?.destroy();
    } catch {}
  }
}

/** 解析 "1.2.3.4:8080" / "socks5://1.2.3.4:1080" / "user:pass@1.2.3.4:1080" */
export function parseProxyLine(line, defaultType = 'http') {
  let s = String(line || '').trim();
  if (!s) return null;
  let type = defaultType;
  const m = /^(socks5|socks4|http|https):\/\//i.exec(s);
  if (m) {
    type = m[1].toLowerCase() === 'socks4' ? 'socks5' : m[1].toLowerCase();
    s = s.slice(m[0].length);
  }
  s = s.split('#')[0].split('/')[0].trim();
  let user;
  let pass;
  const at = s.lastIndexOf('@');
  if (at !== -1) {
    const a = s.slice(0, at).split(':');
    user = a[0];
    pass = a[1] || '';
    s = s.slice(at + 1);
  }
  const hp = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(s);
  if (!hp) return null;
  const host = hp[1].replace(/^\[|\]$/g, '');
  const port = Number(hp[2]);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  if (type === 'https') type = 'http'; // edgetunnel 里 https 走 TLS 到代理，需要额外参数；这里统一按 http
  return { type, host, port, user, pass };
}
