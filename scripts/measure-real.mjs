#!/usr/bin/env node
/**
 * 实测每个节点的「真实客户端延迟」——这才是用户能感知到的那个数字。
 *
 * 为什么需要它：
 *   `latency_ms` 来自 src/probe.mjs，覆盖 DoH 解析 + TLS + SSTP + PPP 协商 +
 *   隧道内 TCP + HTTP 往返，是「首次可用时间」而不是延迟。
 *   `worker_ms` 是 Worker 侧 /admin/check 的耗时，不含「浏览器→CF colo」那一段。
 *   只有这里跑出来的 TTFB 才是客户端真感受到的时间。
 *
 * ⚠️ 血泪教训：**每个节点必须独立一个 Xray 进程**。
 *   曾经把 N 个 vless outbound 塞进同一个 Xray 进程（各自一个 socks inbound，
 *   靠 routing 按 inboundTag 分流），结果同一个 UUID 的多个出站会**互相踢连接**，
 *   表现为头几个节点直接 FAIL、后面的数字乱跳（同一节点 1411ms / 17751ms 都可能）。
 *   独立进程之间不共享状态，所以并发起多个进程是安全的。
 *
 *   node scripts/measure-real.mjs                          # 全部节点
 *   node scripts/measure-real.mjs --limit 20               # 只测前 20 个
 *   node scripts/measure-real.mjs --sub logs/x.txt --out public/data.json
 *   node scripts/measure-real.mjs --timeout 30 --concurrency 3
 *
 * 结果写回 data.json：每节点加 `real_ms`，并重算 stats 里的 real_ms_*。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = process.env.IP_AUTO_UUID || '2900cf6a-b708-4358-8d38-189a4ad4cae7';
const HOST = process.env.IP_AUTO_SUB_HOST || 'ipauto-edge.pages.dev';

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
  }
  return out;
}
const args = argsOf(process.argv.slice(2));
const SUB = path.resolve(ROOT, args.sub || 'logs/sub-pages-decoded.txt');
const OUT = path.resolve(ROOT, args.out || 'public/data.json');
const LIMIT = Number(args.limit || 0);
const BASE_PORT = Number(args['base-port'] || 12000);
const CONC = Number(args.concurrency || 4);
const TIMEOUT = Number(args.timeout || 20);
const STARTUP = Number(args.startup || 2500);

/** 解析一行 vless，取出客户端需要的全部字段 */
function parseVless(line) {
  const m = /^vless:\/\/([^@]+)@([^:]+):(\d+)\?([^#]*)#?(.*)$/.exec(line.trim());
  if (!m) return null;
  const [, uuid, entry, port, qs, name] = m;
  const q = new URLSearchParams(qs);
  return {
    uuid, entry, port: Number(port), name: decodeURIComponent(name || ''),
    path: q.get('path') || '/', host: q.get('host') || HOST,
    sni: q.get('sni') || HOST, fp: q.get('fp') || 'chrome',
    alpn: q.get('alpn') || '', security: q.get('security') || 'tls',
    type: q.get('type') || 'ws',
  };
}

/** 单节点配置：1 个 socks inbound + 1 个 vless outbound */
function buildOne(n, port) {
  const stream = {
    network: 'ws',
    security: n.security === 'tls' ? 'tls' : 'none',
    wsSettings: { path: n.path, headers: { Host: n.host } },
  };
  if (n.security === 'tls') {
    stream.tlsSettings = { serverName: n.sni, allowInsecure: true };
    if (n.alpn) stream.tlsSettings.alpn = n.alpn.split(',').map((s) => s.trim()).filter(Boolean);
    if (n.fp) stream.tlsSettings.fingerprint = n.fp;
  }
  return {
    log: { loglevel: 'error' },
    inbounds: [{ tag: 'in', port, listen: '127.0.0.1', protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
    outbounds: [
      {
        tag: 'out', protocol: 'vless',
        settings: { vnext: [{ address: n.entry, port: n.port, users: [{ id: n.uuid, encryption: 'none' }] }] },
        streamSettings: stream,
      },
      { tag: 'direct', protocol: 'freedom' },
    ],
    routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', inboundTag: ['in'], outboundTag: 'out' }] },
  };
}

/** curl 一次，返回 TTFB 毫秒或 null */
function probePort(port, attempt = 2) {
  for (let i = 0; i < attempt; i++) {
    try {
      const s = execFileSync('curl', [
        '-sS', '--max-time', String(TIMEOUT), '--noproxy', '*',
        '--socks5-hostname', `127.0.0.1:${port}`,
        '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '-w', '%{time_starttransfer} %{http_code}',
        'https://www.gstatic.com/generate_204',
      ], { encoding: 'utf8', timeout: (TIMEOUT + 6) * 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const [t, code] = s.split(' ');
      if (code === '204') return Math.round(Number(t) * 1000);
    } catch { /* 重试一次 */ }
  }
  return null;
}

if (!fs.existsSync(SUB)) {
  console.error(`找不到订阅文件：${SUB}`);
  console.error('先跑：curl -sS -H "user-agent: v2rayN/6.31" "<订阅地址>" | base64 -d > logs/sub-pages-decoded.txt');
  process.exit(1);
}

const bin = path.join(ROOT, 'tools', process.platform === 'win32' ? 'xray.exe' : 'xray');
if (!fs.existsSync(bin)) { console.error(`找不到 ${bin}，先下载 Xray-core`); process.exit(1); }

const lines = fs.readFileSync(SUB, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('vless://'));
const nodes = lines.map(parseVless).filter(Boolean);
const use = LIMIT > 0 ? nodes.slice(0, LIMIT) : nodes;
console.log(`解析 ${nodes.length} 个节点，测 ${use.length} 个（每节点独立进程，并发 ${CONC}，单次超时 ${TIMEOUT}s）`);

const cfgDir = path.join(ROOT, 'logs', 'xray-real');
fs.mkdirSync(cfgDir, { recursive: true });

const results = new Array(use.length).fill(null);
let cursor = 0;
let done = 0;

async function testOne(i) {
  const n = use[i];
  const port = BASE_PORT + i;
  const cfgPath = path.join(cfgDir, `n${i}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(buildOne(n, port), null, 1), 'utf8');
  const child = spawn(bin, ['run', '-c', cfgPath], { cwd: ROOT, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, STARTUP));
    const ms = probePort(port);
    results[i] = ms;
    return ms;
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
  }
}

async function worker() {
  while (cursor < use.length) {
    const i = cursor++;
    const ms = await testOne(i);
    done++;
    console.log(`[${String(done).padStart(String(use.length).length)}/${use.length}] ${use[i].name.padEnd(16)} ${ms === null ? 'FAIL' : ms + 'ms'}`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, use.length) }, worker));
// 等子进程把端口释放掉，避免下一轮 EADDRINUSE
await new Promise((r) => setTimeout(r, 500));

// 写回 data.json
const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
// 匹配方式：订阅第 i 条 ⟷ data.vless_nodes[i]（同一份 buildVlessNodes 生成，顺序一致），
// 再拿 vless_nodes[i].real（真实节点 host:port）去 countries[].nodes 找记录。
const KEY = (host, port) => `${host}:${port}`;
const byKey = new Map();
for (const g of Object.values(data.countries || {})) {
  for (const n of g.nodes || []) byKey.set(KEY(n.host, n.port), n);
}
const vn = Array.isArray(data.vless_nodes) ? data.vless_nodes : [];

let matched = 0;
const flat = [];
for (const [i, n] of use.entries()) {
  const ms = results[i];
  const real = vn[i]?.real || `${n.entry}:${n.port}`;
  const cut = real.lastIndexOf(':');
  const rec = byKey.get(KEY(real.slice(0, cut), real.slice(cut + 1)));
  if (rec) {
    rec.real_ms = ms === null ? null : ms;
    if (ms !== null) matched++;
  }
  flat.push({ name: n.name, real, real_ms: ms, matched: !!rec });
}

// 只把 real_ms 附到节点上，**不改排序**：本轮只测了前 N 个，
// 若用 real_ms 排序，没测到的节点会因 real_ms 缺失被推到末尾，
// 把整个「worker_ms 升序」的顺序打乱。排序仍由 sortLatency（worker_ms）负责。
data.stats = data.stats || {};
data.stats.real_ms_measured = matched;
const vals = flat.filter((x) => x.real_ms !== null).map((x) => x.real_ms).sort((a, b) => a - b);
data.stats.real_ms_median = vals.length ? vals[Math.floor(vals.length / 2)] : null;
data.stats.real_ms_min = vals.length ? vals[0] : null;
fs.writeFileSync(OUT, JSON.stringify(data, null, 1), 'utf8');
fs.writeFileSync(path.join(ROOT, 'logs', 'real-lat.json'), JSON.stringify(flat, null, 1), 'utf8');
try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('');
console.log(`可测 ${matched}/${use.length}，中位 ${data.stats.real_ms_median}ms，最快 ${data.stats.real_ms_min}ms`);
console.log(`已写回 ${OUT}（每节点新增 real_ms 字段）`);
