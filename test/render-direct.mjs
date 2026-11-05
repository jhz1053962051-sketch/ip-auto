/**
 * 校验直连面板渲染：把 logs/direct-sub.json 挂到 data.json 上，渲染到 logs/test-index.html。
 * 只验证 HTML 结构与复制按钮，不写 public/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIndexHtml } from '../src/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const direct = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs/direct-sub.json'), 'utf8'));

data.direct = {
  generated_at: direct.generated_at,
  site: 'https://jhz1053962051-sketch.github.io/ip-auto',
  max_ms: direct.max_ms,
  total: direct.total,
  nodes: direct.nodes,
};

const html = renderIndexHtml(data);
const out = path.join(ROOT, 'logs/test-index.html');
fs.writeFileSync(out, html, 'utf8');

const has = (s) => html.includes(s);
console.log(`输出 ${out}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
console.log('直连面板标题  ', has('⚡ 直连节点'));
console.log('直连说明文案  ', has('不经 Cloudflare'));
console.log('clash 订阅链接 ', has('/direct/clash.yaml'));
console.log('复制地址按钮  ', (html.match(/data-copy="[\d.]+:\d+"/g) || []).length, '个');
console.log('节点总数      ', data.direct.nodes.length);
console.log('主节点表行数  ', (html.match(/<td class="acts">/g) || []).length);
