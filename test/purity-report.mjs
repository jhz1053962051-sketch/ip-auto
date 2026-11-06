/** 打印最脏/最干净节点 + 住宅 vs 机房交叉验证，用于 README / 交付说明。
 *  注意：data.json 里字段有两套写法 ——
 *    countries[].nodes[i].residential 是字符串 'residential' | 'datacenter'
 *    vless_nodes[i].residential      是布尔
 *  一律用 toResi() 归一，别直接取真值判断（字符串 'datacenter' 也是 truthy，会全判成住宅）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));

function toResi(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase().startsWith('res');
  return false;
}

const nodes = (data.vless_nodes && data.vless_nodes.length
  ? data.vless_nodes
  : Object.values(data.countries || {}).flatMap((g) => g.nodes)
).filter((n) => Number.isFinite(n.fraud));

const nameOf = (n) => n.name || `${n.cc || '?'}`;
const ipOf = (n) => n.real_ip || n.purity_ip || n.exit_ip || n.host;
const msOf = (n) => (Number.isFinite(n.real_ms) ? `${Math.round(n.real_ms)}ms` : '-');

const row = (n) =>
  [
    String(n.fraud).padStart(3),
    (n.fraud_risk || '-').padEnd(9),
    nameOf(n).padEnd(14),
    toResi(n.residential) ? '住宅' : '机房',
    (n.fraud_op || '-').slice(0, 28).padEnd(28),
    String(ipOf(n)).padEnd(24),
    msOf(n),
  ].join('  ');

console.log(`=== 最脏 10（共 ${nodes.length} 个可查）===`);
for (const n of nodes.slice().sort((a, b) => b.fraud - a.fraud).slice(0, 10)) console.log(row(n));

console.log('\n=== 最干净 10 ===');
for (const n of nodes.slice().sort((a, b) => a.fraud - b.fraud).slice(0, 10)) console.log(row(n));

const med = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const resi = nodes.filter((n) => toResi(n.residential));
const dc = nodes.filter((n) => !toResi(n.residential));
console.log('\n=== 住宅 vs 机房 ===');
console.log(`住宅 ${resi.length} 个：中位 ${med(resi.map((n) => n.fraud))} 分，脏(≥50) ${resi.filter((n) => n.fraud >= 50).length}`);
console.log(`机房 ${dc.length} 个：中位 ${med(dc.map((n) => n.fraud))} 分，脏(≥50) ${dc.filter((n) => n.fraud >= 50).length}`);
console.log(`全局中位 ${med(nodes.map((n) => n.fraud))} 分，干净(≤24) ${nodes.filter((n) => n.fraud <= 24).length} / 脏 ${nodes.filter((n) => n.fraud >= 50).length}`);
