/**
 * 全量 IP 纯净度扫描（一次性，产出报告用）。
 *
 * 数据源与解析逻辑都走 `src/purity.mjs`，这里只负责「扫一遍 + 打报告」。
 * （早期版本自己写了一份正则，改解析器时两边会走岔，所以合并了。）
 *
 *   $env:https_proxy="http://127.0.0.1:7897"; node test/purity-scan-all.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { probePurityBatch, purityLevel, purityStats } from '../src/purity.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROXY = process.env.https_proxy ? { host: '127.0.0.1', port: 7897 } : null;
const CONCURRENCY = Number(process.env.PURITY_CONCURRENCY || 4);

/**
 * 出口 IP → 节点清单。
 *
 * 节点名不在 data.countries[].nodes 里（那是 buildVlessNodes 现场生成的），
 * 所以名字要从 data.vless_nodes 按「真身地址」反查 —— 早期版本直接读 n.name，
 * 结果全是 undefined，报告里分不清哪条是哪条。
 */
function indexNodes(data) {
  const nameByReal = new Map();
  for (const v of data.vless_nodes || []) {
    if (v.real) nameByReal.set(v.real, v.name);
    if (v.name) nameByReal.set(v.name, v.name);
  }

  const byIp = new Map();
  for (const g of Object.values(data.countries || {})) {
    const cc = String(g.code || '??').toUpperCase();
    for (const n of g.nodes || []) {
      const ip = n.real_ip || n.exit_ip || (/^\d+\.\d+\.\d+\.\d+$/.test(String(n.host || '')) ? n.host : '');
      if (!ip) continue;
      if (!byIp.has(ip)) byIp.set(ip, []);
      byIp.get(ip).push({
        name: nameByReal.get(`${n.host}:${n.port}`) || nameByReal.get(n.name) || `${cc}-${n.host}:${n.port}`,
        cc,
        residential: n.residential === 'residential',
        real_ms: Number.isFinite(n.real_ms) ? n.real_ms : null,
      });
    }
  }
  return byIp;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
  const byIp = indexNodes(data);
  const ips = [...byIp.keys()];
  console.log(`待查 ${ips.length} 个出口 IP，并发 ${CONCURRENCY}\n`);

  const table = await probePurityBatch(ips, {
    proxy: PROXY,
    concurrency: CONCURRENCY,
    log: (m) => console.log(m),
  });

  const rows = [...table.entries()].map(([ip, r]) => ({ ip, ...r, nodes: byIp.get(ip) || [] }));
  const okList = rows.filter((r) => r.ok && Number.isFinite(r.fraud)).sort((a, b) => b.fraud - a.fraud);
  const failList = rows.filter((r) => !r.ok);

  const label = (n) => `${n.name}(${n.residential ? '住宅' : '机房'}${Number.isFinite(n.real_ms) ? ' ' + Math.round(n.real_ms) + 'ms' : ''})`;

  console.log(`\n可查 ${okList.length} / 失败 ${failList.length}`);
  const buckets = { '0': 0, '1-24': 0, '25-49': 0, '50-74': 0, '75-100': 0 };
  for (const r of okList) {
    if (r.fraud === 0) buckets['0']++;
    else if (r.fraud < 25) buckets['1-24']++;
    else if (r.fraud < 50) buckets['25-49']++;
    else if (r.fraud < 75) buckets['50-74']++;
    else buckets['75-100']++;
  }
  console.log('分布:', JSON.stringify(buckets));

  const st = purityStats(okList);
  console.log(`中位 ${st.fraud_median} 分 · 干净 ${st.fraud_clean} · 脏 ${st.fraud_dirty}（含 ${st.fraud_bad} 个 ≥75）`);

  // 核心交叉验证：住宅组 vs 机房组的中位欺诈分
  const resi = okList.filter((r) => r.nodes.some((n) => n.residential));
  const dc = okList.filter((r) => r.nodes.every((n) => !n.residential) && r.nodes.length);
  const rs = purityStats(resi);
  const ds = purityStats(dc);
  console.log(`\n=== 交叉验证「住宅 ≠ 干净」===`);
  console.log(`  住宅组 ${resi.length} 个 IP：中位 ${rs.fraud_median} 分，脏 ${rs.fraud_dirty}/${resi.length}`);
  console.log(`  机房组 ${dc.length} 个 IP：中位 ${ds.fraud_median} 分，脏 ${ds.fraud_dirty}/${dc.length}`);

  console.log('\n=== 最脏的 15 个（fraud 降序）===');
  for (const r of okList.slice(0, 15)) {
    console.log(
      `  fraud=${String(r.fraud).padStart(3)} ${String(purityLevel(r.fraud)?.label || '').padEnd(3)} ${r.ip.padEnd(16)} ` +
        `${r.nodes.map(label).join(' ')}   op=${r.operator}`
    );
  }

  console.log('\n=== 最干净的 10 个 ===');
  for (const r of okList.slice(-10).reverse()) {
    console.log(
      `  fraud=${String(r.fraud).padStart(3)} ${r.ip.padEnd(16)} ${r.nodes.map(label).join(' ')}   op=${r.operator}`
    );
  }

  if (failList.length) {
    console.log('\n=== 查询失败 ===');
    for (const r of failList) console.log(`  ${r.ip}  ${r.error || 'unknown'}`);
  }

  fs.writeFileSync(
    path.join(ROOT, 'logs/purity.json'),
    JSON.stringify({ at: new Date().toISOString(), concurrency: CONCURRENCY, stats: st, results: rows }, null, 1),
    'utf8'
  );
  console.log(`\n已写 logs/purity.json（${rows.length} 条）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
