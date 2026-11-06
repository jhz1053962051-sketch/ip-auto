#!/usr/bin/env node
/**
 * 把一次独立实测（logs/real2.json 那样 {flat:[{name,real,real_ms,real_loc,real_ip}]}）写回
 * public/data.json，并重排 + 重渲染 nodes.txt / 订阅 / 页面。
 *
 * 存在的理由：完整流水线（src/run.mjs）要重新采集 1000+ 节点、跑 10 分钟；
 * 而"只把已有节点重测一遍"不该触发重新采集。
 *
 * ⚠️ 对齐方式：名字（日本-住宅-01…）是 buildVlessNodes 按位置生成的，
 *    country/available 里没有 name 字段，所以先「名字 → vless_nodes」，
 *    再用 vless_nodes 的 real（节点真身 host:port）回填 country/available。
 *    不要用 host:port 直接对，因为 entry 是 CF 边缘 IP（104.26.x.x:443），一堆节点共用。
 *
 *   node scripts/apply-measured.mjs --in logs/real2.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNodesText, EDGE_HOSTS, sortLatency } from '../src/edges.mjs';
import { buildVlessNodes } from '../src/sub.mjs';
import { renderIndexHtml } from '../src/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const IN = path.resolve(ROOT, args.in || 'logs/real2.json');
const DATA = path.resolve(ROOT, args.data || 'public/data.json');

const measured = JSON.parse(fs.readFileSync(IN, 'utf8'));
const flats = Array.isArray(measured) ? measured : measured.flat;
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const byName = new Map();
const byAddr = new Map();
const isEdgeKey = (k) => /^104\.2\d\.|^172\.6[4-7]\.|:443$/.test(String(k || '')) && /^104\.|^172\./.test(String(k || ''));
for (const it of flats) {
  if (!Number.isFinite(it.real_ms)) continue;
  if (it.name) byName.set(it.name, it);
  // 只有「真身地址」才值得当 key；CF 边缘地址（104.26.x.x:443）一堆节点共用，会把回填搞错位
  if (it.real && !isEdgeKey(it.real)) byAddr.set(it.real, it);
}

const strip = (o) => { delete o.real_ms; delete o.real_loc; delete o.real_ip; };

// 0) 清掉旧值（上一次那批是 curl 被拦截层接管时测出来的假数据）
for (const n of data.available || []) strip(n);
for (const g of Object.values(data.countries || {})) for (const n of g.nodes || []) strip(n);
for (const v of data.vless_nodes || []) strip(v);

// 1) 真身地址优先；没有真身 key 时才用名字（名字是按位置生成的，排序后就变了，不可靠）
let hitSub = 0;
for (const v of data.vless_nodes || []) {
  const it = byAddr.get(v.real) || byName.get(v.name);
  if (!it || !Number.isFinite(it.real_ms)) continue;
  // 名字兜底时再确认一次：这条订阅指向的真身必须和 measurement 里的真身一致，否则跳过
  if (!byAddr.has(v.real) && it.real && !isEdgeKey(it.real) && it.real !== v.real) continue;
  v.real_ms = it.real_ms;
  if (it.real_loc) v.real_loc = it.real_loc;
  if (it.real_ip) v.real_ip = it.real_ip;
  hitSub++;
}

// 2) 订阅条目的 real（节点真身）→ country / available
const byReal = new Map();
for (const v of data.vless_nodes || []) {
  if (Number.isFinite(v.real_ms) && v.real) byReal.set(v.real, v);
}
let hit = 0;
const applyOne = (n) => {
  const key = `${n.host}:${n.port}`;
  const v = byReal.get(key);
  if (!v) return false;
  n.real_ms = v.real_ms;
  if (v.real_loc) n.real_loc = v.real_loc;
  if (v.real_ip) n.real_ip = v.real_ip;
  return true;
};
for (const n of data.available || []) if (applyOne(n)) hit++;
for (const g of Object.values(data.countries || {})) for (const n of g.nodes || []) applyOne(n);

const vals = (data.vless_nodes || []).map((v) => v.real_ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
const failed = flats.filter((x) => !Number.isFinite(x.real_ms)).length;
data.stats = data.stats || {};
data.stats.real_ms_measured = vals.length;
data.stats.real_ms_median = vals.length ? vals[Math.floor(vals.length / 2)] : null;
data.stats.real_ms_min = vals.length ? vals[0] : null;
data.stats.real_ms_failed = failed;

// 3.5) 可选：把实测失败的节点直接摘掉（它们要么连不上、要么出口不是预期国家）
if (args['drop-failed']) {
  const before = (data.available || []).length;
  data.available = (data.available || []).filter((n) => Number.isFinite(n.real_ms));
  for (const g of Object.values(data.countries || {})) {
    g.nodes = (g.nodes || []).filter((n) => Number.isFinite(n.real_ms));
    g.count = g.nodes.length;
  }
  data.countries = Object.fromEntries(Object.entries(data.countries || {}).filter(([, g]) => (g.nodes || []).length));
  console.log(`[apply] 摘掉实测失败节点：${before} → ${data.available.length}`);
}

// 3) 排序：real_ms 优先（没测到的沉最后）
if (data.available) data.available.sort(sortLatency);
for (const g of Object.values(data.countries || {})) (g.nodes || []).sort(sortLatency);

// 4) 重建 nodes.txt；订阅按 real_ms 重排
const nodesText = buildNodesText(data, EDGE_HOSTS);
const host = process.env.IP_AUTO_SUB_HOST || 'ipauto-edge.pages.dev';
const uuid = process.env.IP_AUTO_UUID || '2900cf6a-b708-4358-8d38-189a4ad4cae7';
const keep = new Map((data.vless_nodes || []).map((v) => [v.real, v]));
data.vless_nodes = buildVlessNodes(data, { host, uuid, edgeHosts: EDGE_HOSTS });
for (const v of data.vless_nodes) {
  const k = keep.get(v.real);
  if (k && Number.isFinite(k.real_ms)) { v.real_ms = k.real_ms; if (k.real_loc) v.real_loc = k.real_loc; }
}
data.vless_nodes.sort((a, b) => (Number.isFinite(a.real_ms) ? a.real_ms : 1e9) - (Number.isFinite(b.real_ms) ? b.real_ms : 1e9));

fs.writeFileSync(path.join(ROOT, 'public/nodes.txt'), nodesText, 'utf8');
fs.writeFileSync(DATA, JSON.stringify(data, null, 1), 'utf8');
fs.writeFileSync(path.join(ROOT, 'public/index.html'), renderIndexHtml(data), 'utf8');

console.log(`[apply] 订阅命中 ${hitSub}/${(data.vless_nodes || []).length}，节点表回填 ${hit}/${(data.available || []).length}`);
console.log(`[apply] 可测 ${vals.length}，失败 ${failed}${vals.length ? `，中位 ${data.stats.real_ms_median}ms，最快 ${data.stats.real_ms_min}ms` : ''}`);
console.log('[apply] 已重写 nodes.txt / data.json / index.html');