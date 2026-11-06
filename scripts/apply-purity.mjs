/**
 * 把纯净度（Scamalytics 欺诈分）写回一份已有的 public/data.json，并重排 + 重渲染。
 *
 * 为什么要单独一个脚本：`src/run.mjs` 的 7.7 段会跑一遍全量采集（十几分钟），
 * 而纯净度本身只依赖出口 IP、跟采集无关。想单独刷新分数、或者给上一轮产物补分数时，
 * 不该为了一个字段重跑整条流水线。
 *
 *   $env:https_proxy="http://127.0.0.1:7897"; node scripts/apply-purity.mjs
 *   node scripts/apply-purity.mjs --data public/data.json --concurrency 4
 *
 * 写回内容：
 *   countries[].nodes[].fraud / fraud_risk / fraud_op / purity_ip
 *   available[]（同一批对象引用，会一起变）
 *   vless_nodes[]（拷贝出来的，按 real 地址回填）
 *   stats.purity_measured / fraud_median / fraud_clean / fraud_dirty / fraud_bad
 * 然后按 sortLatency 重排（fraud 只做延迟打平时的次级键），重写 nodes.txt 与 index.html。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProxy } from '../src/http.mjs';
import { probePurityBatch, applyPurity, purityStats, purityLevel } from '../src/purity.mjs';
import { buildNodesText, EDGE_HOSTS, sortLatency } from '../src/edges.mjs';
import { renderIndexHtml } from '../src/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dataPath = path.resolve(ROOT, args.data || 'public/data.json');
const publicDir = path.dirname(dataPath);
const concurrency = Number(args.concurrency || process.env.IP_AUTO_PURITY_CONCURRENCY || 4);
const proxyRaw = args.proxy !== undefined ? String(args.proxy) : (process.env.IP_AUTO_PROXY ?? 'http://127.0.0.1:7897');
const proxy = proxyRaw ? parseProxy(proxyRaw) : null;

const log = (...a) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`, ...a);

/** 节点出口 IP：real_ip（实测到的真出口）> exit_ip > host（未走 CF 的直连节点） */
function exitIpOf(n) {
  return n.real_ip || n.exit_ip || (/^\d+\.\d+\.\d+\.\d+$/.test(String(n.host || '')) ? n.host : '');
}

async function main() {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const groups = Object.values(data.countries || {});
  const nodes = groups.flatMap((g) => g.nodes || []);
  if (!nodes.length) throw new Error(`${dataPath} 里没有 countries[].nodes`);

  const ips = [...new Set(nodes.map(exitIpOf).filter(Boolean))];
  log(`节点 ${nodes.length} 个 / 出口 IP ${ips.length} 个，并发 ${concurrency}${proxy ? `，代理 ${proxy.host}:${proxy.port}` : '，直连'}`);

  const table = await probePurityBatch(ips, { proxy, concurrency, log });

  const hit = applyPurity(nodes, table);
  if (Array.isArray(data.available)) applyPurity(data.available, table);
  if (Array.isArray(data.vless_nodes)) {
    const byReal = new Map();
    for (const n of nodes) {
      const ip = exitIpOf(n);
      const r = ip ? table.get(ip) : null;
      if (r && r.ok && Number.isFinite(r.fraud)) byReal.set(`${n.host}:${n.port}`, r);
    }
    for (const v of data.vless_nodes) {
      const r = byReal.get(v.real);
      if (r) { v.fraud = r.fraud; v.fraud_risk = r.risk || null; }
    }
  }

  Object.assign(data.stats, purityStats(nodes));
  log(
    `命中 ${hit}/${nodes.length}，中位 ${data.stats.fraud_median ?? '—'} 分，` +
      `干净 ${data.stats.fraud_clean} / 脏 ${data.stats.fraud_dirty}（含 ${data.stats.fraud_bad} 个 ≥75）`
  );

  // 重排：fraud 只在延迟完全打平时才起作用，不会打乱用户要的「低延迟优先」
  if (Array.isArray(data.available)) data.available.sort(sortLatency);
  for (const g of groups) {
    g.nodes.sort(sortLatency);
    const vals = g.nodes.map((n) => n.fraud).filter((v) => Number.isFinite(v));
    g.fraud_median = vals.length ? vals.slice().sort((a, b) => a - b)[Math.floor((vals.length - 1) / 2)] : null;
  }
  if (Array.isArray(data.vless_nodes)) {
    const rank = new Map();
    for (const g of groups) for (const n of g.nodes) rank.set(`${n.host}:${n.port}`, n.fraud ?? null);
    for (const v of data.vless_nodes) v.fraud ??= rank.get(v.real) ?? null;
    // vless 顺序沿用延迟序，不改（订阅顺序由 run.mjs / buildVlessNodes 定）
  }

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 1), 'utf8');
  fs.writeFileSync(path.join(publicDir, 'index.html'), renderIndexHtml(data), 'utf8');

  // nodes.txt 只有节点集合变了才需要重写；这里节点集合没变，但重排后行序会变，一并重建
  try {
    const txt = buildNodesText(data, EDGE_HOSTS);
    fs.writeFileSync(path.join(publicDir, 'nodes.txt'), txt, 'utf8');
    log(`nodes.txt 重建 ${txt.split('\n').filter(Boolean).length} 行`);
  } catch (e) {
    log(`nodes.txt 重建失败（忽略）：${e?.message || e}`);
  }

  const rows = nodes
    .filter((n) => Number.isFinite(n.fraud))
    .sort((a, b) => (b.fraud - a.fraud) || ((a.real_ms ?? 1e9) - (b.real_ms ?? 1e9)));
  log('\n前 12 脏（分数降序）：');
  for (const n of rows.slice(0, 12)) {
    log(`  ${String(n.fraud).padStart(3)} ${purityLevel(n.fraud)?.label || ''} ${(n.real_ip || n.exit_ip || '').padEnd(16)} ${n.country_code} ${n.residential === 'residential' ? '住宅' : '机房'} ${n.real_ms ?? '—'}ms`);
  }
  log('\n最干净 8 个：');
  for (const n of rows.slice(-8).reverse()) {
    log(`  ${String(n.fraud).padStart(3)} ${(n.real_ip || n.exit_ip || '').padEnd(16)} ${n.country_code} ${n.residential === 'residential' ? '住宅' : '机房'} ${n.real_ms ?? '—'}ms`);
  }

  fs.writeFileSync(
    path.join(ROOT, 'logs', 'purity.json'),
    JSON.stringify({ at: new Date().toISOString(), stats: purityStats(nodes), table: Object.fromEntries(table) }, null, 1),
    'utf8'
  );
  log(`\n已写回 ${path.relative(ROOT, dataPath)} / index.html / nodes.txt / logs/purity.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
