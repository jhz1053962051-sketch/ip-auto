#!/usr/bin/env node
/**
 * 从 public/data.json 导出订阅文本，供 measure-real.mjs 使用。
 *
 * 为什么不用线上订阅：线上订阅可能滞后一轮（Pages 刚部署 vs 本地刚跑完），
 * 条数与顺序对不上，real_ms 就会写到别人头上。这里直接从本地 data.json
 * 用同一份 buildVlessNodes 生成，天然同源同序。
 *
 *   node scripts/dump-sub.mjs                       # → logs/sub-local.txt
 *   node scripts/dump-sub.mjs --out logs/x.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildVlessNodes } from '../src/sub.mjs';

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
const DATA = path.resolve(ROOT, args.data || 'public/data.json');
const OUT = path.resolve(ROOT, args.out || 'logs/sub-local.txt');

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const sub = data.subscription || {};
const host = args.host || sub.host || 'ipauto-edge.pages.dev';
const uuid = args.uuid || sub.uuid || process.env.IP_AUTO_UUID || '2900cf6a-b708-4358-8d38-189a4ad4cae7';

const nodes = buildVlessNodes(data, { host, uuid });
if (!nodes.length) {
  console.error('data.json 里没有可导出的节点（countries 为空？）');
  process.exit(1);
}
fs.writeFileSync(OUT, nodes.map((n) => n.vless).join('\n') + '\n', 'utf8');
console.log(`导出 ${nodes.length} 条 → ${OUT}`);
