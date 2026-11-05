/**
 * 本地检测服务（Cloudflare 检测 Worker 的本机等价物）
 *
 * 作用：
 *   1. 给你一个真正能跑的 `/check?sstp=vpn:vpn@host:port` 接口（和线上 Worker 返回结构一致）
 *   2. GitHub Actions / 其它机器可以把 CHECK_WORKER 指向本机（需公网可访问，或用 Cloudflare Tunnel）
 *   3. 离线自测：不依赖 Cloudflare 账号就能验证整条链路
 *
 * 用法：
 *   node scripts/local-worker.mjs                 # 监听 127.0.0.1:8787
 *   node scripts/local-worker.mjs --port 8787 --host 0.0.0.0
 *
 * 接口：
 *   GET /check?sstp=vpn:vpn@host:port   → {success,responseTime,colo,exit:{...},error}
 *   GET /check?host=1.2.3.4&port=443    → 同上
 *   GET /                               → 说明页
 */
import http from 'node:http';
import { parseProxy } from '../src/http.mjs';
import { checkNode } from '../src/probe.mjs';
import { normalizeExit, lookupIps } from '../src/geo.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.IP_AUTO_WORKER_PORT || 8787);
const HOST = args.host || process.env.IP_AUTO_WORKER_HOST || '127.0.0.1';
const PROXY = parseProxy(process.env.IP_AUTO_PROXY ?? 'http://127.0.0.1:7897');
const TIMEOUT = Number(process.env.IP_AUTO_TIMEOUT_MS || 22000);

/** 解析 `sstp=vpn:vpn@host:port` / `host:port` / 显式 host+port 参数 */
function parseTarget(url) {
  const sp = url.searchParams;
  const raw = sp.get('sstp') || sp.get('socks5') || sp.get('http') || sp.get('https') || sp.get('turn') || '';
  let host = sp.get('host') || sp.get('target') || '';
  let port = Number(sp.get('port') || 0);
  let user = 'vpn';
  let pass = 'vpn';

  if (raw) {
    let s = raw.trim();
    const at = s.lastIndexOf('@');
    if (at !== -1) {
      const auth = s.slice(0, at);
      s = s.slice(at + 1);
      const ci = auth.indexOf(':');
      if (ci !== -1) { user = auth.slice(0, ci); pass = auth.slice(ci + 1); }
      else user = auth;
    }
    const m = s.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (m) {
      host = m[1].replace(/^\[|\]$/g, '');
      port = Number(m[2] || 0) || port;
    }
  }
  if (!host) return null;
  return { host, port: port || 443, user, pass };
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const send = (code, obj) => {
    const body = JSON.stringify(obj, null, 1);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  if (url.pathname === '/' || url.pathname === '/help') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>ip-auto 本地检测服务</title>
<body style="font:14px/1.7 -apple-system,Segoe UI,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;background:#0b0f17;color:#e6edf6">
<h1 style="font-size:20px">ip-auto 本地检测服务</h1>
<p>Cloudflare 检测 Worker 的本机等价实现（SSTP 握手 + 隧道内取出口 IP）。</p>
<pre style="background:#121a26;border:1px solid #22303f;border-radius:12px;padding:16px;overflow:auto">
GET /check?sstp=vpn:vpn@host:port
GET /check?host=1.2.3.4&amp;port=443
</pre>
<p>返回结构：<code>{ success, responseTime, colo, exit: { ip, country, country_code, asn, is_datacenter }, error }</code></p>
<p>示例：<a style="color:#5b9cff" href="/check?sstp=vpn:vpn@public-vpn-129.opengw.net:443">/check?sstp=vpn:vpn@public-vpn-129.opengw.net:443</a></p>
</body>`);
    return;
  }

  if (url.pathname !== '/check') {
    send(404, { success: false, error: 'not found' });
    return;
  }

  const target = parseTarget(url);
  if (!target) {
    send(400, { success: false, error: 'missing target: use ?sstp=vpn:vpn@host:port or ?host=&port=' });
    return;
  }

  const r = await checkNode(target, { proxy: PROXY, timeoutMs: TIMEOUT });
  if (!r.ok) {
    send(200, {
      success: false,
      type: 'sstp',
      rawValue: `${target.host}:${target.port}`,
      error: r.error,
      responseTime: r.responseTime,
      colo: 'LOCAL',
    });
    return;
  }

  // 与线上 Worker 的 exit 结构对齐（asn 是对象）；顺手做一次归属查询补全 country/asn
  let rec = null;
  try {
    const map = await lookupIps([r.exitIp], { proxy: PROXY, timeoutMs: 15000 });
    rec = map.get(r.exitIp) || null;
  } catch (e) {
    console.warn(`[ip-auto] 归属查询失败: ${e.message}`);
  }
  const exit = normalizeExit(r.exitIp, rec, r.host);
  send(200, {
    success: true,
    type: 'sstp',
    rawValue: `${target.host}:${target.port}`,
    responseTime: r.responseTime,
    colo: 'LOCAL',
    exit: {
      ip: r.exitIp,
      country: exit.country,
      country_code: exit.country_code,
      asn: { asn: exit.asn, org: exit.org, name: exit.asname, type: null },
      is_datacenter: exit.residential === 'datacenter' ? true : exit.residential === 'residential' ? false : null,
    },
    assigned_ip: r.assignedIp,
    elapsed: Date.now() - t0,
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[ip-auto] 本地检测服务已启动 http://${HOST}:${PORT}`);
  console.log(`[ip-auto] 示例: http://${HOST}:${PORT}/check?sstp=vpn:vpn@public-vpn-129.opengw.net:443`);
  console.log(`[ip-auto] 代理: ${PROXY ? `${PROXY.host}:${PROXY.port}` : '直连'} | 单次超时 ${TIMEOUT}ms`);
});
