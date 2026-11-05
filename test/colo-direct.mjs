/**
 * 直连扫每个候选入口落到哪个 colo（读 /cdn-cgi/trace 的 colo=）。
 *
 * 为什么要这一步：
 *   端到端 A/B（test/entry-ab.mjs）显示 HKG 那三个固定 IP 稳定 2.5~3.1s 且 2/2 成功，
 *   而 LAX 的几个虽然本地 TLS 握手更快（0.56~0.62s），实测却一半超时。
 *   原因不是「本机到 CF」快慢，而是 **Worker 跑在 colo 上** —— colo 决定 Worker 出网到
 *   日韩住宅 SSTP 节点的距离。colo=HKG 时 Worker→日本只要一次短跳，colo=LAX 要跨太平洋两个来回。
 *   所以入口筛选的第一判据是 colo，不是本机 TLS 耗时。
 *
 * 踩坑记录（2026-11-05）：
 *   上一版失败路径没 destroy socket，net.connect 的 fd 泄漏让 Node 事件循环不退出，
 *   整个进程跑满 300s 被转后台 job 且无任何输出。这一版所有失败路径都 destroy，
 *   并且最后显式 process.exit(0)，避免任何残留句柄挂住进程。
 *
 * 用法：node test/colo-direct.mjs [--json logs/colo-direct.json] [--concurrency 8]
 */
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import fs from 'node:fs';

const SNI = 'ipauto-edge.pages.dev';

const CANDIDATES = [
  // 固定 anycast IP
  '104.26.10.209', '162.159.140.98', '172.67.74.209', '172.66.44.226',
  '104.16.0.1', '104.17.0.1', '104.18.0.1', '104.19.0.1',
  '104.20.0.1', '104.21.0.1', '104.24.0.1', '104.25.0.1',
  '104.26.0.1', '104.27.0.1', '104.28.0.1',
  '172.64.0.1', '172.65.0.1', '172.66.0.1', '172.67.0.1',
  // 优选域名
  'www.mfyx.cn', 'cdn.204910.best', 'cdn.ctn32.us.kg', 'www.dbs.com.sg',
  'www.sloomb.com', 'op.chinwa.eu.cc', 'p.etime.vip', 'cf.nyanya.moe',
  'spring.io', 'www.vmware.com', 'www.shopify.com', 'www.leics.police.uk',
];

function withTimeout(p, ms, label) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} 超时`)), ms);
    p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}

function readTrace(sock) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = d => {
      buf += d;
      if (buf.includes('colo=') && buf.includes('\n')) {
        cleanup();
        resolve(buf);
      }
    };
    const onEnd = () => { cleanup(); resolve(buf); };
    const onErr = e => { cleanup(); reject(e); };
    const timer = setTimeout(() => { cleanup(); resolve(buf); }, 8000);
    function cleanup() {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('end', onEnd);
      sock.off('error', onErr);
    }
    sock.on('data', onData);
    sock.on('end', onEnd);
    sock.on('error', onErr);
    sock.setEncoding('utf8');
    sock.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${SNI}\r\nUser-Agent: colo\r\nConnection: close\r\n\r\n`);
  });
}

async function coloOf(host) {
  const t0 = Date.now();
  let ip = host, dnsMs = 0;
  let tcpSock = null, tlsSock = null;
  try {
    if (!net.isIP(host)) {
      const a = await withTimeout(dns.resolve4(host), 5000, 'DNS');
      if (!a?.length) throw new Error('无 A 记录');
      ip = a[0];
      dnsMs = Date.now() - t0;
    }

    tcpSock = await withTimeout(new Promise((res, rej) => {
      const s = net.connect({host: ip, port: 443});
      s.setNoDelay(true);
      s.once('connect', () => res(s));
      s.once('error', rej);
    }), 8000, 'TCP');

    tlsSock = await withTimeout(new Promise((res, rej) => {
      const s = tls.connect({socket: tcpSock, servername: SNI, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false});
      s.once('secureConnect', () => res(s));
      s.once('error', rej);
    }), 8000, 'TLS');

    const body = await readTrace(tlsSock);
    const m = /(?:^|\n)colo=([A-Z]{3})/.exec(body);
    return {host, ip, dns_ms: dnsMs, total_ms: Date.now() - t0, colo: m ? m[1] : null, ok: !!m};
  } catch (e) {
    return {host, ip, dns_ms: dnsMs, total_ms: Date.now() - t0, colo: null, ok: false, error: String(e.message || e)};
  } finally {
    // 关键：任何路径都要销毁，否则 fd 泄漏会让进程挂住
    try { tlsSock?.destroy(); } catch {}
    try { tcpSock?.destroy(); } catch {}
  }
}

function pool(items, limit, fn) {
  return new Promise(resolve => {
    const out = new Array(items.length);
    let i = 0, done = 0;
    const next = () => {
      if (i >= items.length) return;
      const k = i++;
      fn(items[k]).then(r => out[k] = r).catch(e => out[k] = {host: items[k], ok: false, error: String(e?.message || e)}).finally(() => {
        if (++done === items.length) resolve(out); else next();
      });
    };
    for (let n = 0; n < Math.min(limit, items.length); n++) next();
  });
}

const args = process.argv.slice(2);
const j = args.indexOf('--json');
const jsonOut = j >= 0 ? args[j + 1] : 'logs/colo-direct.json';
const c = args.indexOf('--concurrency');
const concurrency = c >= 0 ? Number(args[c + 1]) : 8;

const results = await pool(CANDIDATES, concurrency, coloOf);

// 亚太 colo 排序靠前：colo 决定 Worker→节点的距离
const order = {HKG: 0, NRT: 1, KIX: 2, ICN: 3, TPE: 4, SIN: 5, BKK: 6};
results.sort((a, b) => {
  if (a.ok !== b.ok) return a.ok ? -1 : 1;
  const oa = order[a.colo] ?? 9, ob = order[b.colo] ?? 9;
  if (oa !== ob) return oa - ob;
  return (a.total_ms || 1e9) - (b.total_ms || 1e9);
});

const byColo = {};
for (const r of results) {
  const k = r.ok ? r.colo : 'FAIL';
  (byColo[k] ||= []).push(r);
}

console.log('直连 colo 扫描 —— SNI=' + SNI + '\n');
for (const [colo, list] of Object.entries(byColo)) {
  console.log(`${colo}  (${list.length})`);
  for (const r of list) {
    console.log('   ' + (r.host + ' '.repeat(Math.max(0, 22 - r.host.length))) +
      String(r.total_ms || '-').padStart(6) + 'ms  ip=' + (r.ip || '-') +
      (r.error ? '  ' + r.error : ''));
  }
  console.log('');
}

const asia = results.filter(r => r.ok && ['HKG', 'NRT', 'KIX', 'ICN', 'TPE', 'SIN'].includes(r.colo));
console.log(`亚太 colo 可用入口 ${asia.length} 个`);
for (const r of asia) console.log('   ' + r.colo + '  ' + r.host);

fs.mkdirSync('logs', {recursive: true});
fs.writeFileSync(jsonOut, JSON.stringify({generated_at: new Date().toISOString(), sni: SNI, results}, null, 2));
console.log('\n写入 ' + jsonOut);
process.exit(0);
