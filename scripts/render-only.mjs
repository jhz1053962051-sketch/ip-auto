#!/usr/bin/env node
/**
 * 只重新渲染 index.html，不重新探测节点。
 *
 * 用途：改完 `src/render.mjs` 或 `src/sub.mjs` 后想立刻看效果，
 * 又不想等一整轮 40 秒的探测。
 *
 *   node scripts/render-only.mjs                 # 读 public/data.json → 重写 public/index.html
 *   node scripts/render-only.mjs --out logs/view.html
 *   node scripts/render-only.mjs --host other.pages.dev --uuid <uuid>
 *
 * 会顺手把 `subscription` 与 `vless_nodes` 算进 data.json（幂等，重复跑结果相同）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { subToken, subUrls, buildVlessNodes } from '../src/sub.mjs';
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
const src = path.resolve(ROOT, args.src || 'public/data.json');
const out = path.resolve(ROOT, args.out || 'public/index.html');
const host = args.host || process.env.IP_AUTO_SUB_HOST || 'ipauto-edge.pages.dev';
const uuid = args.uuid || process.env.IP_AUTO_UUID || '2900cf6a-b708-4358-8d38-189a4ad4cae7';

const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const token = subToken(host, uuid);
data.subscription = { host, uuid, token, ...subUrls(host, token) };
data.vless_nodes = buildVlessNodes(data, { host, uuid });

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, renderIndexHtml(data), 'utf8');

const size = fs.statSync(out).size;
console.log(`输入 ${src}`);
console.log(`输出 ${out}  (${(size / 1024).toFixed(1)} KB)`);
console.log(`节点 ${data.vless_nodes.length} 个 · 订阅 ${data.subscription.sub}`);
