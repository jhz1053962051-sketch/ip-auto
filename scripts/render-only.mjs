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
import { buildNodesText } from '../src/edges.mjs';
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

// 直连节点（scripts/make-direct-sub.mjs 的产出）也要挂进页面：
// 它是唯一「比绕 Worker 快 600ms 以上」的一批，藏在公共目录里没人会去看。
// 这里从 logs/direct-sub.json 回填，保证只重渲染时面板不会消失。
const directPath = path.resolve(ROOT, args.direct || 'logs/direct-sub.json');
if (!args['no-direct'] && fs.existsSync(directPath)) {
  try {
    const d = JSON.parse(fs.readFileSync(directPath, 'utf8'));
    if (Array.isArray(d.nodes) && d.nodes.length) {
      data.direct = {
        generated_at: d.generated_at,
        site: args.site || process.env.IP_AUTO_SITE || 'https://jhz1053962051-sketch.github.io/ip-auto',
        max_ms: d.max_ms,
        total: d.nodes.length,
        nodes: d.nodes,
      };
    }
  } catch (e) {
    console.log(`直连节点读取失败（跳过面板）：${e?.message || e}`);
  }
}

// 顺带回写 data.json：页面和订阅都从 vless_nodes 取数，不写的话下次重渲染又会缺字段
fs.writeFileSync(src, JSON.stringify(data, null, 2), 'utf8');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, renderIndexHtml(data), 'utf8');

// nodes.txt 也一起重排：改了排序算法后如果只重渲染页面，线上订阅文件的顺序还是旧的，
// 页面和订阅就对不上（用户看到的第一个节点 ≠ 客户端测速最快的那个）。
if (!args['no-nodes']) {
  const nodesOut = path.resolve(ROOT, args.nodes || 'public/nodes.txt');
  fs.writeFileSync(nodesOut, buildNodesText(data), 'utf8');
  console.log(`节点表 ${nodesOut}  (${data.vless_nodes.length} 行)`);
}

const size = fs.statSync(out).size;
console.log(`输入 ${src}`);
console.log(`输出 ${out}  (${(size / 1024).toFixed(1)} KB)`);
console.log(`节点 ${data.vless_nodes.length} 个 · 订阅 ${data.subscription.sub}`);
