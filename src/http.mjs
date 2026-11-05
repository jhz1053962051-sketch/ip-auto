/**
 * 极简 HTTP(S) 客户端，支持 HTTP CONNECT 代理隧道。
 * 不引入任何第三方依赖，只用 node:net / node:tls / node:https。
 */
import net from 'node:net';
import tls from 'node:tls';

import http from 'node:http';

/** 解析代理配置：支持 http://user:pass@host:port 或 host:port */
export function parseProxy(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '');
  const at = s.lastIndexOf('@');
  let auth = null;
  let hostport = s;
  if (at !== -1) {
    const authPart = s.slice(0, at);
    hostport = s.slice(at + 1);
    const ci = authPart.indexOf(':');
    if (ci !== -1) auth = { user: authPart.slice(0, ci), pass: authPart.slice(ci + 1) };
    else auth = { user: authPart, pass: '' };
  }
  const m = hostport.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return null;
  return {
    host: m[1].replace(/^\[|\]$/g, ''),
    port: Number(m[2] || 7890),
    auth,
  };
}

/** 通过代理建立到 host:port 的裸 TCP 隧道 */
export function connectViaProxy(proxy, host, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`连接代理 ${proxy.host}:${proxy.port} 超时`)), timeoutMs);
    socket.setNoDelay(true);
    socket.on('error', (e) => { clearTimeout(timer); fail(e); });

    const onData = (chunk) => {
      const text = chunk.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end === -1) {
        // 头部还没收完，继续等（保持同一 buffer 累积）
        buffered += text;
        if (buffered.length > 16384) { clearTimeout(timer); socket.removeListener('data', onData); fail(new Error('代理响应头过长')); }
        return;
      }
      buffered += text;
      const headerEnd = buffered.indexOf('\r\n\r\n');
      const header = buffered.slice(0, headerEnd);
      const statusLine = header.split('\r\n')[0] || '';
      const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
      if (!m || Number(m[1]) < 200 || Number(m[1]) >= 300) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        fail(new Error(`代理 CONNECT 失败: ${statusLine}`));
        return;
      }
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (settled) return;
      settled = true;
      resolve(socket);
    };

    let buffered = '';
    socket.once('connect', () => {
      let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (proxy.auth) {
        const b = Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64');
        req += `Proxy-Authorization: Basic ${b}\r\n`;
      }
      req += '\r\n';
      socket.write(req);
      socket.on('data', onData);
    });
  });
}

/** 建立到 host:port 的 TCP（可选代理） */
export async function connectTcp(host, port, proxy, timeoutMs = 15000) {
  if (proxy) return connectViaProxy(proxy, host, port, timeoutMs);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`连接 ${host}:${port} 超时`)); }, timeoutMs);
    socket.setNoDelay(true);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 在已有 socket 上做 TLS 握手（不校验证书链，SSTP 自签常见） */
export function tlsUpgrade(rawSocket, servername, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      socket: rawSocket,
      servername: net.isIP(servername) ? undefined : servername,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
      minVersion: 'TLSv1.2',
    });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TLS 握手超时')); }, timeoutMs);
    socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 简单 HTTP 请求（支持代理 + 自定义超时），返回 { status, headers, body }
 * 只处理 HTTP/1.1 的 content-length / chunked 两种情况。
 */
/** 在已建立的 socket 上手写一个 HTTP/1.1 请求并解析响应 */
function rawHttpOver(socket, { method = 'GET', host, path, headers, timeoutMs, body = null }) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      fn(v);
    };

    const bodyBuf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const hasHeader = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    const autoHeaders = [];
    // 有请求体就必须带 Content-Length，否则服务端读不到 body（POST 表单会失败）
    if (bodyBuf && bodyBuf.length && !hasHeader('content-length')) autoHeaders.push(`Content-Length: ${bodyBuf.length}`);

    const headerLines = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Connection: close',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ...autoHeaders,
      '',
      '',
    ].join('\r\n');

    let head = null;
    let need = null;
    const tryComplete = () => {
      if (!head) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        head = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 4);
        const clm = head.match(/\r\ncontent-length:\s*(\d+)/i);
        if (clm) need = Number(clm[1]);
        else if (/transfer-encoding:\s*chunked/i.test(head)) need = null;
        else need = -1; // 读到 EOF
      }
      if (need === null) {
        // chunked
        const text = buf.toString('latin1');
        if (!text.includes('\r\n0\r\n\r\n') && !text.endsWith('0\r\n\r\n')) return;
        let cur = 0;
        let out = '';
        for (;;) {
          const e = text.indexOf('\r\n', cur);
          if (e === -1) return;
          const size = parseInt(text.slice(cur, e).split(';')[0].trim(), 16);
          if (!Number.isFinite(size)) return;
          cur = e + 2;
          if (size === 0) break;
          out += text.slice(cur, cur + size);
          cur += size + 2;
        }
        finish(resolve, { head, body: Buffer.from(out, 'latin1').toString('utf8') });
        return;
      }
      if (need === -1) {
        return; // 等 EOF
      }
      if (buf.length >= need) {
        finish(resolve, { head, body: buf.subarray(0, need).toString('utf8') });
      }
    };

    const timer = setTimeout(() => finish(reject, new Error('HTTP 请求超时')), timeoutMs);

    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (buf.length > 8 * 1024 * 1024) return finish(reject, new Error('响应过大'));
      tryComplete();
    });
    socket.on('end', () => {
      if (!head) return finish(reject, new Error('响应为空'));
      const idx = /** @type {string} */ (head).indexOf('\r\n');
      const body = buf.toString('utf8');
      finish(resolve, { head, body });
    });
    socket.on('close', () => {
      if (settled) return;
      if (!head) return finish(reject, new Error('连接已关闭'));
      finish(resolve, { head, body: buf.toString('utf8') });
    });
    socket.on('error', (e) => finish(reject, e));

    if (body && body.length) socket.write(Buffer.concat([Buffer.from(headerLines, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')]));
    else socket.write(headerLines, 'latin1');
    if (buf.length) tryComplete();
  });
}

export async function httpRequest(url, opts = {}) {
  const { proxy = null, timeoutMs = 20000, headers = {}, method = 'GET', body: reqBody = null, connectIp = null } = opts;
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port || (isHttps ? 443 : 80));
  const host = u.hostname;

  // 建连（TCP + TLS）单独用一个更短的预算：被掐的地址通常卡在握手阶段一动不动，
  // 若跟整体超时共用 40s，一次死连接就把整个重试预算吃光。
  // 真正的业务耗时（Worker 里建 SSTP 隧道）走 timeoutMs，不受这个影响。
  const connectTimeout = Number(opts.connectTimeoutMs) > 0 ? Number(opts.connectTimeoutMs) : Math.min(timeoutMs, 10000);

  // connectIp：连这个 IP，但 SNI 与 Host 仍是 URL 里的域名。
  // 为什么要这个口子：`*.pages.dev` 直连经常在 TLS 握手阶段被掐（实测 5 次里 2 次超时），
  // 而 Cloudflare 的 anycast IP（104.26.x.x 那批香港 colo）稳定得多 —— 同一个边缘节点，
  // 按 SNI 路由到同一个 Pages 项目。少了 DNS 与「解析到哪个 colo」的不确定性。
  const dialHost = connectIp || host;
  const raw = await connectTcp(dialHost, port, proxy, connectTimeout);
  const socket = isHttps ? await tlsUpgrade(raw, host, connectTimeout) : raw;

  const { head, body } = await rawHttpOver(socket, {
    method,
    host: u.host,
    path: `${u.pathname}${u.search}`,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ip-auto/1.0)',
      Accept: '*/*',
      ...headers,
    },
    timeoutMs,
    body: reqBody,
  });

  const statusLine = head.split('\r\n')[0] || '';
  const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  const status = m ? Number(m[1]) : 0;
  const headerMap = {};
  for (const line of head.split('\r\n').slice(1)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    headerMap[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status, headers: headerMap, body };
}

export async function httpJson(url, opts) {
  const r = await httpRequest(url, opts);
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} ${url}`);
  return JSON.parse(r.body);
}
