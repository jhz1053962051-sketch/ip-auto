/** 验收：public/index.html 里确实有欺诈分列、说明条、配色与统计卡 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));

const checks = [
  ['页面含「欺诈分」表头', /<th title="Scamalytics 欺诈分/.test(html)],
  ['页面含「住宅 ≠ 干净」说明', html.includes('「住宅」不等于「干净」')],
  ['页面含欺诈分中位数统计卡', html.includes('欺诈分中位数')],
  ['至少一个 fraud 单元格', /<span class="fraud [a-z]+"/.test(html)],
  ['data.json 有 fraud_median', Number.isFinite(data.stats.fraud_median)],
  ['data.json 每节点都有 fraud', (data.countries ? Object.values(data.countries).flatMap((g) => g.nodes) : []).every((n) => Number.isFinite(n.fraud))],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) bad++;
}

const cells = html.match(/<span class="fraud [a-z]+" title="[^"]*">(\d+)<\/span>/g) || [];
const tones = {};
for (const c of cells) {
  const t = (c.match(/fraud ([a-z]+)/) || [])[1];
  tones[t] = (tones[t] || 0) + 1;
}
console.log(`\nfraud 单元格 ${cells.length} 个，配色分布 ${JSON.stringify(tones)}`);
console.log(`stats: ${JSON.stringify({
  purity_measured: data.stats.purity_measured,
  fraud_median: data.stats.fraud_median,
  fraud_clean: data.stats.fraud_clean,
  fraud_dirty: data.stats.fraud_dirty,
  fraud_bad: data.stats.fraud_bad,
  real_ms_median: data.stats.real_ms_median,
  success: data.stats.success,
})}`);
console.log(`HTML ${(html.length / 1024).toFixed(1)} KB`);
process.exit(bad ? 1 : 0);
