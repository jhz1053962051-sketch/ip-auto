/**
 * 扩大扫描：从 Cloudflare 公开 anycast 段里挑候选 IP，找更多 colo=HKG 的入口。
 *
 * 背景：直连扫描（test/colo-direct.mjs）发现 31 个候选里只有 4 个落 HKG
 * （104.26.10.209 / 104.26.0.1 / 162.159.140.98 / 172.67.74.209），其余 19 个全落 LAX。
 * 而端到端 A/B 证明 HKG 的稳定 2.5~3.1s 且 100% 成功，LAX 的一半超时（15s+）。
 * 所以要多找几个 HKG 做轮转池，避免所有节点挤在 4 个 IP 上。
 *
 * 判据：只看 /cdn-cgi/trace 的 colo=，不看 TLS 耗时（TLS 快慢不代表 Worker 在哪）。
 *
 * 用法：node test/colo-hunt.mjs [--json logs/colo-hunt.json]
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';

const SNI = 'ipauto-edge.pages.dev';

// Cloudflare 公布的 anycast 段里，历史上有 HKG 落点的常见第三/四段组合
const PREFIXES = [
  '104.26.', '104.27.', '104.28.',
  '172.64.', '172.65.', '172.66.', '172.67.', '172.68.', '172.69.', '172.70.', '172.71.',
  '162.159.', '188.114.', '190.93.', '197.234.', '198.41.',
];
const LAST_OCTETS = ['1', '10', '20'];

const CANDIDATES = [];
for (const p of PREFIXES) {
  for (const l of LAST_OCTETS) {
    // 段是 a.b.c. 的形式，补一个第三段
    const base = p.split('.').filter(Boolean); // ['104','26']
    if (base.length === 2) {
      for (const third of ['10', '0', '1']) CANDIDATES.push(`${base[0]}.${base[1]}.${third}.${l}`);
    } else if (base.length === 3) {
      CANDIDATES.push(`${base[0]}.${base[1]}.${base[2]}.${l}`);
    }
  }
}

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
      if (buf.includes('colo=')) { cleanup(); resolve(buf); }
    };
    const onEnd = () => { cleanup(); resolve(buf); };
    const onErr = e => { cleanup(); reject(e); };
    const timer = setTimeout(() => { cleanup(); resolve(buf); }, 6000);
    function cleanup() {
      clearTimeout(timer);
      sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onErr);
    }
    sock.on('data', onData); sock.on('end', onEnd); sock.on('error', onErr);
    sock.setEncoding('utf8');
    sock.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${SNI}\r\nUser-Agent: colo\r\nConnection: close\r\n\r\n`);
  });
}

async function coloOf(ip) {
  const t0 = Date.now();
  let tcp = null, ts = null;
  try {
    tcp = await withTimeout(new Promise((res, rej) => {
      const s = net.connect({host: ip, port: 443});
      s.setNoDelay(true);
      s.once('connect', () => res(s));
      s.once('error', rej);
    }), 5000, 'TCP');

    ts = await withTimeout(new Promise((res, rej) => {
      const s = tls.connect({socket: tcp, servername: SNI, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false});
      s.once('secureConnect', () => res(s));
      s.once('error', rej);
    }), 5000, 'TLS');

    const body = await readTrace(ts);
    const m = /(?:^|\n)colo=([A-Z]{3})/.exec(body);
    return {ip, total_ms: Date.now() - t0, colo: m ? m[1] : null, ok: !!m};
  } catch (e) {
    return {ip, total_ms: Date.now() - t0, colo: null, ok: false, error: String(e.message || e)};
  } finally {
    try { ts?.destroy(); } catch {}
    try { tcp?.destroy(); } catch {}
  }
}

function pool(items, limit, fn) {
  return new Promise(resolve => {
    const out = new Array(items.length);
    let i = 0, done = 0;
    const next = () => {
      if (i >= items.length) return;
      const k = i++;
      fn(items[k]).then(r => out[k] = r).catch(e => out[k] = {ok: false, ip: items[k], error: String(e?.message || e)}).finally(() => {
        if (++done === items.length) resolve(out); else next();
      });
    };
    for (let n = 0; n < Math.min(limit, items.length); n++) next();
  });
}

const args = process.argv.slice(2);
const j = args.indexOf('--json');
const jsonOut = j >= 0 ? args[j + 1] : 'logs/colo-hunt.json';

console.log(`扫描 ${CANDIDATES.length} 个候选 IP 找 HKG colo…`);
const results = await pool(CANDIDATES, 16, coloOf);

const byColo = {};
for (const r of results) {
  if (!r.ok) continue;
  (byColo[r.colo] ||= []).push(r);
}

console.log('\ncolo 分布：');
for (const [colo, list] of Object.entries(byColo).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${colo}  ${list.length} 个`);
}

const asia = ['HKG', 'NRT', 'KIX', 'ICN', 'TPE', 'SIN', 'BKK', 'KUL'];
const picks = [];
for (const c of asia) {
  for (const r of (byColo[c] || []).sort((a, b) => a.total_ms - b.total_ms)) picks.push(r);
}

console.log(`\n亚太 colo 入口 ${picks.length} 个（按耗时）：`);
for (const r of picks) console.log(`  ${r.colo}  ${r.ip.padEnd(16)} ${r.total_ms}ms`);

fs.mkdirSync('logs', {recursive: true});
fs.writeFileSync(jsonOut, JSON.stringify({generated_at: new Date().toISOString(), sni: SNI, total: CANDIDATES.length, byColo: Object.fromEntries(Object.entries(byColo).map(([k, v]) => [k, v.sort((a, b) => a.total_ms - b.total_ms)])), asia_picks: picks}, null, 2));
console.log('\n写入 ' + jsonOut);
process.exit(0);
