/**
 * 批量测「直连可达性」：对 nodes.txt 里每个节点的底层 host:port，
 * DoH 解析出 IP，再直连 TCP 探端口。
 *
 * 背景（本轮关键发现）：
 *   本机 DNS 解析不了 `*.opengw.net`（ENOENT），但用 DoH 拿到 IP 后直连 TCP 是通的
 *   （实测 `121.153.105.45:1646` 186ms SYN-ACK、`111.99.247.245:1752` 162ms）。
 *   也就是说：**不必经 Cloudflare + Worker 绕一圈**，本机可以直连 VPN Gate 节点，
 *   用 Windows 原生 SSTP / OpenVPN 客户端拨号，延迟能回到正常 VPN 的 100~300ms，
 *   而出口仍是同一批住宅 IP。
 *
 * 这个脚本回答两件事：
 *   1. 有多少比例的家宽节点端口可以从本机直连（决定这条路是否值得做）
 *   2. 443 端口 vs 随机高端口 的可达性差异（判断是不是 443 被重点干扰）
 *
 * 用法：node test/direct-reach.mjs [--nodes public/nodes.txt] [--limit 0]
 */
import fs from 'node:fs';
import net from 'node:net';
import { httpRequest, parseProxy } from '../src/http.mjs';
import { mapPool } from '../src/pool.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const NODES = arg('nodes', 'public/nodes.txt');
const LIMIT = Number(arg('limit', '0'));
const DOH = process.env.IP_AUTO_DOH || 'https://dns.google/resolve';
const proxy = parseProxy('http://127.0.0.1:7897');

const dohCache = new Map();
async function resolveA(host) {
  if (dohCache.has(host)) return dohCache.get(host);
  let out = [];
  try {
    const r = await httpRequest(`${DOH}?name=${encodeURIComponent(host)}&type=A`, {
      proxy, timeoutMs: 15000, headers: { accept: 'application/dns-json' },
    });
    out = (JSON.parse(r.body).Answer || []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {}
  dohCache.set(host, out);
  return out;
}

function tcpProbe(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok, extra = '') => {
      if (done) return;
      done = true; sock.destroy();
      resolve({ ok, ms: Date.now() - started, extra });
    };
    sock.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    sock.once('connect', () => finish(true, 'OK'));
    sock.once('error', (e) => finish(false, e.code || String(e.message || e)));
  });
}

function parseNodeLine(line) {
  // entry:port#国家-类型-NN$proto://[user:pass@]host:port
  const m = /^([^#]+)#([^$]+)\$(.+)$/.exec(line.trim());
  if (!m) return null;
  const link = m[3];
  const lm = /^([a-z0-9]+):\/\/(?:[^@/]*@)?(\[?[^\]:/]+\]?):(\d+)/i.exec(link);
  if (!lm) return null;
  return { entry: m[1], name: m[2], proto: lm[1].toLowerCase(), host: lm[2].replace(/^\[|\]$/g, ''), port: Number(lm[3]) };
}

let nodes = fs.readFileSync(NODES, 'utf8').split('\n').map(parseNodeLine).filter(Boolean);
if (LIMIT > 0) nodes = nodes.slice(0, LIMIT);
// 只测 sstp（住宅），http 代理本来就是直连的
const targets = nodes.filter((n) => n.proto === 'sstp');
console.log(`测 ${targets.length} 个 SSTP 节点的直连可达性（DoH 解析 + 直连 TCP）\n`);

const results = await mapPool(targets, 12, async (n) => {
  const ips = await resolveA(n.host);
  if (!ips.length) return { ...n, ok: false, reason: 'DNS 无记录' };
  const r = await tcpProbe(ips[0], n.port);
  return { ...n, ip: ips[0], ok: r.ok, reason: r.extra, ms: r.ms };
}, (done, total, r) => {
  if (r) console.log(`[${String(done).padStart(3)}/${total}] ${r.name.padEnd(14)} ${String(r.host).padEnd(28)}:${String(r.port).padEnd(5)} ${r.ok ? `直连 OK ${r.ms}ms` : `FAIL ${r.reason}`}`);
});

const ok = results.filter((r) => r.ok);
const port443 = results.filter((r) => r.port === 443);
const portOther = results.filter((r) => r.port !== 443);

console.log(`\n直连可达 ${ok.length}/${results.length}`);
console.log(`  端口 443   : ${port443.filter((r) => r.ok).length}/${port443.length}`);
console.log(`  随机高端口 : ${portOther.filter((r) => r.ok).length}/${portOther.length}`);
if (ok.length) {
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`  握手耗时 min=${ms[0]}ms p50=${ms[Math.floor((ms.length - 1) / 2)]}ms max=${ms[ms.length - 1]}ms`);
  console.log(`\n可直接拨号的节点：`);
  for (const r of ok.slice(0, 20)) console.log(`  ${r.name.padEnd(14)} ${r.ip}:${r.port}  ${r.ms}ms`);
}

fs.mkdirSync('logs', { recursive: true });
fs.writeFileSync('logs/direct-reach.json', JSON.stringify({
  generated_at: new Date().toISOString(), total: results.length, ok: ok.length,
  port443: { ok: port443.filter((r) => r.ok).length, total: port443.length },
  portRandom: { ok: portOther.filter((r) => r.ok).length, total: portOther.length },
  results,
}, null, 2));
console.log('\n写入 logs/direct-reach.json');
process.exit(0);
