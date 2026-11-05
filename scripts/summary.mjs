/**
 * 输出本轮结果摘要，供 GitHub Actions Step Summary 使用。
 * 读 public/data.json，打印到 stdout；有 GITHUB_STEP_SUMMARY 时额外写入 Markdown。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const file = path.join(ROOT, 'public', 'data.json');

if (!fs.existsSync(file)) {
  console.error('public/data.json 不存在，先跑 node src/run.mjs');
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = d.stats || {};

const lines = [
  `原始 ${s.raw_rows} 条 → SSTP ${s.sstp_nodes} 条 → 检测 ${s.checked} 条`,
  `成功 ${s.success}（住宅 ${s.residential} / 机房 ${s.datacenter}），失败 ${s.failed}`,
  `生成时间 ${d.generated_at}`,
];
console.log(lines.join('\n'));

// 按国家细分
const byCountry = Object.values(d.countries || {})
  .sort((a, b) => b.count - a.count)
  .map((g) => `${g.name_zh || g.name || g.code} ${g.count} 个（住宅 ${g.residential}）`);
if (byCountry.length) console.log(`国家分布：${byCountry.join(' / ')}`);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const md = [
    '### 本轮结果',
    '',
    `- 原始 **${s.raw_rows}** 条 → SSTP **${s.sstp_nodes}** 条 → 检测 **${s.checked}** 条`,
    `- 可用 **${s.success}** 个（住宅 ${s.residential} / 机房 ${s.datacenter}）`,
    `- 生成时间 ${d.generated_at}`,
    byCountry.length ? `- 国家分布：${byCountry.join(' / ')}` : '',
    '',
  ].filter((x) => x !== '').join('\n');
  fs.appendFileSync(summaryPath, md + '\n', 'utf8');
}
