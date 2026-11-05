/**
 * 直连（不走本机 7897）扫描入口的**真实**耗时。
 *
 * 为什么要单独一个脚本：
 *   之前所有入口耗时都是用 curl 经 127.0.0.1:7897 测的，测到的是「本机 → 代理 → CF」，
 *   而用户实际是「本机 → CF」直连。两条路径的差异非常大（代理那条 0.4s，直连那条 2.9s），
 *   拿代理下的排名去做优选入口是错的。
 *
 * 判据：DNS 解析 → TCP connect → TLS 握手（SNI 固定 ipauto-edge.pages.dev）→
 *       发 GET /version?uuid=... → 读到首字节。三段分别计时，失败记原因。
 *
 * 用法：node test/direct-edge-scan.mjs [--json logs/direct-edge.json]
 */
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import fs from 'node:fs';

const SNI = 'ipauto-edge.pages.dev';
const UUID = '2900cf6a-b708-4358-8d38-189a4ad4cae7';
const PATH = `/version?uuid=${UUID}`;

const CANDIDATES = [
  // 固定 anycast IP
  '104.26.10.209', '162.159.140.98', '172.67.74.209', '172.66.44.226',
  '172.64.152.5', '104.17.0.1', '104.18.0.1', '104.19.0.1',
  '104.25.0.1', '104.16.0.1', '104.24.0.1', '104.27.0.1',
  // 优选域名
  'www.mfyx.cn', 'cdn.204910.best', 'cdn.ctn32.us.kg', 'www.dbs.com.sg',
  'www.sloomb.com', 'op.chinwa.eu.cc', 'www.shopify.com', 'spring.io',
  'www.vmware.com', 'p.etime.vip', 'cf.nyanya.moe', 'cf.877774.xyz',
  // 裸域（客户端默认会走这个）
  SNI,
];

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function scan(host, {timeoutMs = 12000} = {}) {
  const t0 = Date.now();
  const out = {host, dns_ms: null, tcp_ms: null, tls_ms: null, ttfb_ms: null, total_ms: null, colo: null, ok: false, error: null};
  let ip = host;
  try {
    if (!net.isIP(host)) {
      const addrs = await withTimeout(dns.resolve4(host), 5000, 'DNS');
      if (!addrs.length) throw new Error('DNS 无 A 记录');
      ip = addrs[0];
      out.ip = ip;
      out.dns_ms = Date.now() - t0;
    } else {
      out.ip = ip;
      out.dns_ms = 0;
    }
  } catch (e) {
    out.error = `DNS: ${e.message}`;
    out.total_ms = Date.now() - t0;
    return out;
  }

  // TCP
  const tTcp = Date.now();
  let sock;
  try {
    sock = await withTimeout(new Promise((resolve, reject) => {
      const s = net.connect({host: ip, port: 443});
      s.setNoDelay(true);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    }), timeoutMs, 'TCP');
    out.tcp_ms = Date.now() - tTcp;
  } catch (e) {
    out.error = `TCP: ${e.message}`;
    out.total_ms = Date.now() - t0;
    return out;
  }

  // TLS
  const tTls = Date.now();
  let tsock;
  try {
    tsock = await withTimeout(new Promise((resolve, reject) => {
      const s = tls.connect({socket: sock, servername: SNI, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false});
      s.once('secureConnect', () => resolve(s));
      s.once('error', reject);
    }), timeoutMs, 'TLS');
    out.tls_ms = Date.now() - tTls;
    if (tsock.alpnProtocol) out.alpn = tsock.alpnProtocol;
  } catch (e) {
    out.error = `TLS: ${e.message}`;
    out.total_ms = Date.now() - t0;
    try { sock.destroy(); } catch {}
    return out;
  }

  // HTTP
  const tH = Date.now();
  try {
    const body = await withTimeout(new Promise((resolve, reject) => {
      let buf = '';
      tsock.setEncoding('utf8');
      tsock.write(`GET ${PATH} HTTP/1.1\r\nHost: ${SNI}\r\nUser-Agent: scan\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      tsock.on('data', d => {
        buf += d;
        if (out.ttfb_ms === null) out.ttfb_ms = Date.now() - tH;
        const idx = buf.indexOf('\r\n\r\n');
        if (idx > 0) {
          const head = buf.slice(0, idx);
          const m = /content-length:\s*(\d+)/i.exec(head);
          const rest = buf.slice(idx + 4);
          if (m && rest.length >= Number(m[1])) resolve(buf);
          else if (/connection:\s*close/i.test(head) && !m) resolve(buf);
        }
      });
      tsock.on('end', () => resolve(buf));
      tsock.on('error', reject);
    }), timeoutMs, 'HTTP');

    const status = /^HTTP\/1\.[01] (\d{3})/.exec(body)?.[1];
    out.status = status ? Number(status) : null;
    out.body_len = body.length;
    out.ok = out.status === 200 && body.includes('Version');
    if (!out.ok) out.error = `HTTP ${out.status}`;
  } catch (e) {
    out.error = `HTTP: ${e.message}`;
  } finally {
    try { tsock.destroy(); } catch {}
  }
  out.total_ms = Date.now() - t0;
  return out;
}

function pool(items, limit, fn) {
  return new Promise(resolve => {
    const results = new Array(items.length);
    let i = 0, done = 0;
    const next = () => {
      if (i >= items.length) return;
      const idx = i++;
      Promise.resolve(fn(items[idx])).then(r => { results[idx] = r; }).catch(e => { results[idx] = {host: items[idx], ok: false, error: String(e?.message || e)}; }).finally(() => {
        done++;
        if (done === items.length) resolve(results);
        else next();
      });
    };
    for (let k = 0; k < Math.min(limit, items.length); k++) next();
  });
}

const args = process.argv.slice(2);
const jsonOut = (() => { const i = args.indexOf('--json'); return i >= 0 ? args[i + 1] : 'logs/direct-edge.json'; })();
const concurrency = (() => { const i = args.indexOf('--concurrency'); return i >= 0 ? Number(args[i + 1]) : 6; })();

const results = await pool(CANDIDATES, concurrency, h => scan(h));
results.sort((a, b) => {
  if (a.ok !== b.ok) return a.ok ? -1 : 1;
  return (a.total_ms ?? 1e9) - (b.total_ms ?? 1e9);
});

console.log('直连（无代理）入口扫描 —— SNI=' + SNI);
console.log('rank  入口                         DNS     TCP     TLS     TTFB    总耗时   结果');
results.forEach((r, i) => {
  const p = v => (v === null || v === undefined) ? '   -  ' : String(v).padStart(5) + 'ms';
  console.log(
    String(i + 1).padStart(3) + '  ' +
    (r.host + ' '.repeat(Math.max(0, 26 - r.host.length))) +
    p(r.dns_ms) + '  ' + p(r.tcp_ms) + '  ' + p(r.tls_ms) + '  ' + p(r.ttfb_ms) + '  ' + p(r.total_ms) + '  ' +
    (r.ok ? 'OK' : (r.error || 'FAIL'))
  );
});

const good = results.filter(r => r.ok);
console.log(`\n可用 ${good.length}/${results.length}`);
if (good.length) console.log('前五个：' + good.slice(0, 5).map(r => `${r.host}(${r.total_ms}ms)`).join(' '));

fs.mkdirSync('logs', {recursive: true});
fs.writeFileSync(jsonOut, JSON.stringify({generated_at: new Date().toISOString(), sni: SNI, results}, null, 2));
console.log('写入 ' + jsonOut);
