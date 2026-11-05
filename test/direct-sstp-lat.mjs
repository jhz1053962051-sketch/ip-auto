/**
 * 直连住宅节点的「实测延迟」—— 不走 Cloudflare、不走 Worker、不走 7897。
 *
 * 背景（本轮最重要的发现）：
 *   本机 DNS 不解析 `*.opengw.net`（ENOENT），但用 DoH 拿到 IP 后，直连 TCP 是通的：
 *     韩国-住宅-02  1.225.40.245:1308     61ms
 *     韩国-住宅-04  218.158.183.96:995     71ms
 *     韩国-住宅-19  59.12.131.120:1831     93ms
 *     日本-住宅-02  219.100.37.17:443     111ms
 *   而经「CF colo → Worker → SSTP」同一批节点要 2.5~3s。
 *
 *   所以真正该给用户的是**直连订阅**：客户端不经过 Worker，直接对住宅节点拨 SSTP。
 *   本脚本用项目自带的 `src/sstp.mjs`（完整 SSTP + PPP 实现，已在 probe 里跑了几个月）
 *   在**直连**路径上建立隧道并取出口 IP，测的就是用户原生客户端会遇到的延迟。
 *
 * 用法：node test/direct-sstp-lat.mjs [--nodes public/nodes.txt] [--limit 0] [--concurrency 4]
 */
import fs from 'node:fs';
import { httpRequest, parseProxy } from '../src/http.mjs';
import { sstpEstablish, createTcpOverPpp, httpOverSstp } from '../src/sstp.mjs';
import { mapPool } from '../src/pool.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const NODES = arg('nodes', 'public/nodes.txt');
const LIMIT = Number(arg('limit', '0'));
const CONC = Number(arg('concurrency', '4'));
const TIMEOUT = Number(arg('timeout', '20000'));
const DOH = process.env.IP_AUTO_DOH || 'https://dns.google/resolve';
// DoH 解析需要出网：本机直连 dns.google 不通，走 7897；隧道本身是直连的。
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

function parseNodeLine(line) {
  const m = /^([^#]+)#([^$]+)\$(.+)$/.exec(line.trim());
  if (!m) return null;
  const lm = /^([a-z0-9]+):\/\/(?:([^:@/]*):([^@/]*)@)?(\[?[^\]:/]+\]?):(\d+)/i.exec(m[3]);
  if (!lm) return null;
  return {
    entry: m[1], name: m[2], proto: lm[1].toLowerCase(),
    user: lm[2] || 'vpn', pass: lm[3] || 'vpn',
    host: lm[4].replace(/^\[|\]$/g, ''), port: Number(lm[5]),
  };
}

async function measure(node) {
  const t0 = Date.now();
  const ips = await resolveA(node.host);
  if (!ips.length) return { ...node, ok: false, error: 'DNS 无记录' };
  const ip = ips[0];
  const tDns = Date.now() - t0;
  try {
    const sstp = await sstpEstablish({
      host: ip, port: node.port,
      user: node.user, pass: node.pass, timeoutMs: TIMEOUT,
    });
    const tUp = Date.now() - t0;
    const exitIp = sstp.assignedIp || null;
    // 隧道内取一次出口 IP（与 Worker 的 admin/check 同一判据）
    let trace = null;
    try {
      const tcp = createTcpOverPpp(sstp, sstp.assignedIp, '104.16.132.229');
      trace = await httpOverSstp({ sstp, tcp, targetHost: 'cloudflare.com', path: '/cdn-cgi/trace', timeoutMs: TIMEOUT });
    } catch {}
    const total = Date.now() - t0;
    try { sstp.close?.(); } catch {}
    return { ...node, ip, ok: true, dns_ms: tDns, handshake_ms: tUp, total_ms: total, exitIp, trace: trace ? String(trace).slice(0, 160) : null };
  } catch (e) {
    return { ...node, ip, ok: false, error: String(e?.message || e).slice(0, 110), handshake_ms: Date.now() - t0 };
  }
}

let nodes = fs.readFileSync(NODES, 'utf8').split('\n').map(parseNodeLine).filter(Boolean)
  .filter((n) => n.proto === 'sstp');
if (LIMIT > 0) nodes = nodes.slice(0, LIMIT);
console.log(`直连测 ${nodes.length} 个 SSTP 住宅节点（DoH 解析 + 直连 SSTP + PPP + 隧道内 trace）\n`);

const results = await mapPool(nodes, CONC, measure, (done, total, r) => {
  if (!r) return;
  const tag = r.ok ? `OK  握手 ${String(r.handshake_ms).padStart(5)}ms  总 ${String(r.total_ms).padStart(5)}ms` : `FAIL ${(r.error || '').slice(0, 60)}`;
  console.log(`[${String(done).padStart(2)}/${total}] ${r.name.padEnd(14)} ${String(r.ip || '-').padEnd(16)}:${String(r.port).padEnd(5)} ${tag}`);
});

const ok = results.filter((r) => r.ok);
console.log(`\n直连成功 ${ok.length}/${results.length}`);
if (ok.length) {
  for (const k of ['handshake_ms', 'total_ms']) {
    const v = ok.map((r) => r[k]).sort((a, b) => a - b);
    console.log(`  ${k.padEnd(13)} min=${v[0]}ms p50=${v[Math.floor((v.length - 1) / 2)]}ms max=${v[v.length - 1]}ms`);
  }
  console.log('\n最快十个（直连，无 CF 无 Worker）：');
  ok.sort((a, b) => a.total_ms - b.total_ms).slice(0, 10).forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(14)} ${r.ip}:${r.port}  ${r.total_ms}ms  出口 ${r.exitIp || '?'}`);
  });
}

fs.mkdirSync('logs', { recursive: true });
fs.writeFileSync('logs/direct-sstp.json', JSON.stringify({
  generated_at: new Date().toISOString(), total: results.length, ok: ok.length, results,
}, null, 2));
console.log('\n写入 logs/direct-sstp.json');
process.exit(0);
