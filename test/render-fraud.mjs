/** 渲染冒烟测试：把伪造的 fraud 分塞进 data.json 的一份拷贝，看列/说明条/配色是否出现 */
import fs from 'node:fs';
import path from 'node:path';
import { renderIndexHtml } from '../src/render.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));

const samples = [0, 12, 45, 68, 100, 3];
// 页面走的是 vless_nodes（collectNodes 优先用它），所以两处都塞，模拟 run.mjs 的回填行为
for (const list of [data.available || [], data.vless_nodes || []]) {
  list.slice(0, samples.length).forEach((n, i) => {
    n.fraud = samples[i];
    n.fraud_risk = samples[i] >= 75 ? 'very high' : samples[i] >= 50 ? 'high' : 'low';
  });
}
Object.assign(data.stats, {
  purity_measured: 51,
  fraud_median: 13,
  fraud_clean: 23,
  fraud_dirty: 18,
  fraud_bad: 15,
});

const html = renderIndexHtml(data);
fs.writeFileSync(path.join(ROOT, 'logs/test-fraud.html'), html, 'utf8');

const checks = [
  ['表头有「欺诈分」', html.includes('<th title="Scamalytics 欺诈分')],
  ['说明条出现', html.includes('「住宅」不等于「干净」')],
  ['统计卡出现', html.includes('欺诈分中位数')],
  ['绿标 ok', html.includes('class="fraud ok"')],
  ['灰标 dim', html.includes('class="fraud dim"')],
  ['橙标 warn', html.includes('class="fraud warn"')],
  ['红标 bad', html.includes('class="fraud bad"')],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) bad++;
}

const cells = html.match(/<span class="fraud [a-z]+"[^>]*>\d+<\/span>/g) || [];
console.log(`\n共 ${cells.length} 个 fraud 单元格，前 8 个：`);
for (const c of cells.slice(0, 8)) console.log('   ' + c);

// 只校验我们塞了 fraud 的那 6 个，其它节点没有分应显示 —
console.log(`\nHTML ${(html.length / 1024).toFixed(1)} KB → logs/test-fraud.html`);
process.exit(bad ? 1 : 0);
