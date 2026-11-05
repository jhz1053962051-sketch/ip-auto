/**
 * 扫描一批 Cloudflare anycast 入口，记录每个入口的 colo 与 TLS 握手耗时。
 *
 * 目的：从大陆访问 Cloudflare 时，不同 anycast 前缀会落到不同机房（HKG/LAX/NRT/SJC…）。
 * Worker 就运行在那个机房，所以 colo 决定了 Worker→VPN Gate 节点的 RTT。
 * 日本节点如果从 NRT(东京) 机房出去，RTT 只有几毫秒；从 LAX 出去要 120ms+，
 * 而 SSTP 建链要跑 6~8 个 RTT —— 这一项就是 1 秒以上的差距。
 *
 *   node test/colo-scan.mjs
 */
import * as tls from 'node:tls';
import fs from 'node:fs';

const SNI = 'ipauto-edge.pages.dev';
const CANDIDATES = [
  // 我们自己在用的
  '104.26.10.209', '162.159.140.98', '172.67.74.209', '172.66.44.226',
  '172.64.152.5', '172.64.156.171', '104.21.0.1', '172.66.0.96',
  // 常见 CF anycast 段抽样
  '104.16.0.1', '104.16.132.229', '104.17.0.1', '104.18.0.1', '104.19.0.1',
  '104.20.0.1', '104.22.0.1', '104.23.0.1', '104.24.0.1', '104.25.0.1',
  '104.27.0.1', '104.28.0.1', '108.162.192.1', '131.0.72.1', '141.101.64.1',
  '162.158.0.1', '172.64.0.1', '172.65.0.1', '172.68.0.1', '172.69.0.1',
  '172.70.0.1', '172.71.0.1', '173.245.48.1', '188.114.96.1', '190.93.240.1',
  '197.234.240.1', '198.41.128.1',
  // 常用作优选域名的
  'www.mfyx.cn', 'cdn.204910.best', 'cdn.ctn32.us.kg', 'www.dbs.com.sg',
  'www.sloomb.com', 'op.chinwa.eu.cc', 'www.shopify.com', 'www.visa.com.sg',
];

function probe(host) {
  return new Promise((resolve) => {
    const id = String(id_counter++);
    void id;
    const t0 = Date.now();
    let tlsMs = null;
    const sock = tls.connect({
      host, port: 443, servername: SNI, rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const done = (r) => { try { sock.destroy(); } catch {} resolve(r); };
    const timer = setTimeout(() => done({ host, ok: false, err: 'timeout' }), 12000);
    sock.once('secureConnect', () => {
      tlsMs = Date.now() - t0;
      const t1 = Date.now();
      sock.write(
        `GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${SNI}\r\nUser-Agent: curl/8\r\n` +
        `Connection: close\r\nAccept: */*\r\n\r\n`
      );
      let buf = '';
      sock.on('data', (d) => { buf += d.toString('latin1'); });
      sock.on('end', () => {
        clearTimeout(timer);
        const body = buf.slice(buf.indexOf('\r\n\r\n') + 4);
        const colo = (body.match(/^colo=(\S+)/m) || [])[1] || '?';
        done({ host, ok: true, colo, tlsMs, ttfbMs: Date.now() - t1 });
      });
      sock.on('close', () => {
        clearTimeout(timer);
        if (tlsMs === null) return done({ host, ok: false, err: 'closed before data' });
        const body = buf.slice(buf.indexOf('\r\n\r\n') + 4);
        const colo = (body.match(/^colo=(\S+)/m) || [])[1] || '?';
        done({ host, ok: true, colo, tlsMs, ttfbMs: Date.now() - t1 });
      });
    });
    sock.once('error', (e) => { clearTimeout(timer); done({ host, ok: false, err: e.code || e.message }); });
  });
}
let id_counter = 0;

const rows = [];
for (const h of CANDIDATES) {
  const r = await probe(h);
  rows.push(r);
  if (r.ok) console.log(`${h.padEnd(20)} ${r.colo.padEnd(5)} tls=${String(r.tlsMs).padStart(5)}ms ttfb=${String(r.ttfbMs).padStart(5)}ms`);
  else console.log(`${h.padEnd(20)} FAIL  ${r.err}`);
}
fs.writeFileSync('logs/colo-scan.json', JSON.stringify(rows, null, 1));

const byColo = {};
for (const r of rows.filter((x) => x.ok)) (byColo[r.colo] ||= []).push(r);
console.log('\n=== colo 分布 ===');
for (const [k, v] of Object.entries(byColo).sort((a, b) => b[1].length - a[1].length)) {
  v.sort((a, b) => a.tlsMs - b.tlsMs);
  console.log(`${k}: ${v.length} 个，最快 ${v[0].host} (tls=${v[0].tlsMs}ms ttfb=${v[0].ttfbMs}ms)`);
}
