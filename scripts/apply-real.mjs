#!/usr/bin/env node
/**
 * 把 measure-real.mjs 测出来的 real_ms 精确写回 data.json。
 *
 * 为什么需要它：measure-real 原来按「订阅第 i 条 ⟷ vless_nodes[i]」匹配，
 * 只在本地产物和线上订阅**完全同源同序**时才成立。一旦本地 data.json 是 58 个
 * 节点、而订阅是线上上一轮的 55 个，索引就整体错位，real_ms 会被写到别人的节点上。
 *
 * 这里改用**地址精确匹配**：vless 的 path 是 `/video/<base64>`，base64 解出来是
 * XOR(UUID) 后的 JSON `{type,hostname,port}` —— 这就是节点的真身，与顺序无关。
 *
 * real-lat.json 的每项带 `real`（真实 host:port）与 `real_ms`。
 *   旧版 measure-real 写的 real 可能不准（它回落成 entry:port），
 *   所以这里优先用 `--sub` 解析出的第 i 条地址覆盖第 i 项，再按地址建索引。
 *
 *   node scripts/apply-real.mjs --sub logs/live-sub.txt --lat logs/real-lat.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const SUB = path.resolve(ROOT, args.sub || 'logs/live-sub.txt');
const LAT = path.resolve(ROOT, args.lat || 'logs/real-lat.json');
const DATA = path.resolve(ROOT, args.data || 'public/data.json');

/** XOR 解码 payload（与 _worker.js:4751 base64SecretEncode 对称） */
function decodePayload(pathname, secret) {
  const raw = String(pathname || '').replace(/^\/video\//, '').replace(/^\//, '');
  if (!raw) return null;
  let buf;
  try { buf = Buffer.from(decodeURIComponent(raw), 'base64'); } catch { return null; }
  if (!buf.length) return null;
  const key = Buffer.from(secret, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  try { return JSON.parse(out.toString('utf8')); } catch { return null; }
}

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const uuid = data.subscription?.uuid || process.env.IP_AUTO_UUID || '2900cf6a-b708-4358-8d38-189a4ad4cae7';

// 1) 订阅顺序解析出真实 host:port（这是权威的「第 i 条是谁」）
const subAddr = [];
if (fs.existsSync(SUB)) {
  for (const line of fs.readFileSync(SUB, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('vless://')) continue;
    const m = /^vless:\/\/[^@]+@([^:]+):(\d+)\?([^#]*)#?(.*)$/.exec(s);
    if (!m) continue;
    const q = new URLSearchParams(m[3]);
    const payload = decodePayload(q.get('path'), uuid);
    if (!payload?.hostname) continue;
    subAddr.push(`${payload.hostname}:${Number(payload.port)}`);
  }
}

// 2) real_ms 按地址建索引：real-lat.json 的第 i 项 ⟷ 订阅第 i 条
const byAddr = new Map();
if (fs.existsSync(LAT)) {
  const lat = JSON.parse(fs.readFileSync(LAT, 'utf8'));
  const sameLen = subAddr.length && subAddr.length === lat.length;
  for (const [i, it] of lat.entries()) {
    if (it?.real_ms === null || it?.real_ms === undefined) continue;
    let key = sameLen ? subAddr[i] : it.real;
    if (!key) continue;
    byAddr.set(key, it.real_ms);
  }
  if (!sameLen) {
    console.log(`注意：订阅 ${subAddr.length} 条 vs 实测 ${lat.length} 条，数量不一致，退回按 real 字段匹配`);
  }
}

// 3) 写回 countries[].nodes
let hit = 0;
let miss = 0;
for (const g of Object.values(data.countries || {})) {
  for (const n of g.nodes || []) {
    const ms = byAddr.get(`${n.host}:${n.port}`);
    if (Number.isFinite(ms)) { n.real_ms = ms; hit++; } else { miss++; }
  }
}

// 4) vless_nodes 同步（页面用它渲染）
if (Array.isArray(data.vless_nodes)) {
  for (const vn of data.vless_nodes) {
    const ms = vn.real ? byAddr.get(vn.real) : undefined;
    if (Number.isFinite(ms)) vn.real_ms = ms;
  }
}

// 5) 重算 stats
const vals = [];
for (const g of Object.values(data.countries || {})) {
  for (const n of g.nodes || []) if (Number.isFinite(n.real_ms)) vals.push(n.real_ms);
}
vals.sort((a, b) => a - b);
data.stats = data.stats || {};
data.stats.real_ms_measured = vals.length;
data.stats.real_ms_median = vals.length ? vals[Math.floor(vals.length / 2)] : null;
data.stats.real_ms_min = vals.length ? vals[0] : null;

fs.writeFileSync(DATA, JSON.stringify(data, null, 1), 'utf8');
console.log(`订阅解析 ${subAddr.length} 条 · real_ms 索引 ${byAddr.size} 条`);
console.log(`写回命中 ${hit} / 未命中 ${miss}`);
console.log(`real_ms：可测 ${vals.length} · 中位 ${data.stats.real_ms_median}ms · 最快 ${data.stats.real_ms_min}ms`);
console.log(`已写 ${DATA}`);
