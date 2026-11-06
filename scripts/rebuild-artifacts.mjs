/**
 * 从 public/data.json 单一真源重建所有派生产物。
 *
 * 为什么需要它：`public/` 里有 4 个产物是同一份数据的四种投影，
 *   data.json       —— 真源
 *   index.html      —— 渲染
 *   nodes.txt       —— edgetunnel 每天来取的节点池（**订阅就是从这里生成的**）
 *   subscription.txt —— 简单订阅（Clash/v2rayN 可直接吃）
 * 平时 `run.mjs` 会一次性写全，但凡是「只改数据、不重采集」的脚本
 * （`apply-purity.mjs` / `apply-measured.mjs`）或 git 合并/变基，
 * 都可能只更新其中一两个，出现「页面 64 个、订阅 69 个」这种对不上的情况
 * —— 2026-11-06 变基时就这么错过一次：origin 的 nodes.txt 被原样保留下来。
 *
 * 用法：
 *   node scripts/rebuild-artifacts.mjs          # 重建全部
 *   node scripts/rebuild-artifacts.mjs --check  # 只比对，不一致就 exit 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNodesText, EDGE_HOSTS, nodeLink } from '../src/edges.mjs';
import { renderIndexHtml } from '../src/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const dataPath = path.join(PUBLIC, 'data.json');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// available 是「这一轮过关的全部节点」，countries 是它的分组视图。
// 两者对象引用相同，节点集合应当一致 —— 不一致就说明有人只改了一边。
const available = Array.isArray(data.available) ? data.available : [];
const fromCountries = Object.values(data.countries || {}).flatMap((g) => g.nodes || []);

// 简单订阅：和国家分组无关，纯按 available 的当前顺序（已被 sortLatency 排过）
const simpleSub =
  available
    .map((n) => `#${n.country_code || '??'}-${n.residential === 'residential' ? '住宅' : '机房'}-${n.exit_ip || ''}\n${nodeLink(n)}`)
    .join('\n') + '\n';

const out = {
  'nodes.txt': buildNodesText(data, EDGE_HOSTS),
  'subscription.txt': simpleSub,
  'index.html': renderIndexHtml(data),
};

const countLines = (s) => s.split('\n').filter((l) => l.trim()).length;

console.log(`data.json：available ${available.length} / countries 合计 ${fromCountries.length} / vless_nodes ${(data.vless_nodes || []).length}`);
if (available.length !== fromCountries.length) {
  console.log(`  ⚠️ available 与 countries 不一致（差 ${fromCountries.length - available.length} 个）`);
}

let bad = 0;
for (const [name, content] of Object.entries(out)) {
  const p = path.join(PUBLIC, name);
  const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const same = old === content;
  const extra = name === 'nodes.txt' ? `（${countLines(content)} 行 vs 磁盘 ${countLines(old)} 行）` : '';
  console.log(`  ${same ? '=' : '≠'} ${name}${extra}`);

  if (CHECK) {
    if (!same) bad++;
    continue;
  }
  if (!same) {
    fs.writeFileSync(p, content, 'utf8');
    console.log(`    → 已重写 ${name}`);
  }
}

// 只有 nodes.txt 的行数才是「订阅里会有几个节点」，单独打出来
const subCount = countLines(out['nodes.txt']);
const vlessCount = (data.vless_nodes || []).length;
console.log(`\n订阅节点数（nodes.txt 行数）${subCount}｜页面表格节点数（vless_nodes）${vlessCount}`);
if (subCount !== vlessCount) {
  console.log('  ⚠️ 两者应相等：页面看 64 个、订阅给 69 个，用户会以为少了一批节点');
  bad++;
}

if (CHECK) {
  console.log(bad ? `\n有 ${bad} 处不一致` : '\n全部一致');
  process.exit(bad ? 1 : 0);
}
console.log('\n完成');