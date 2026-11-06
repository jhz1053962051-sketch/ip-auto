/**
 * 线上验收：GitHub Pages 上的产物是否真的带了欺诈分。
 * 走 httpRequest（进程内 TLS），绕开本机那个会忽略代理参数的 curl。
 * 加 ?t= 打散 CDN 缓存，否则拿到的是上一版。
 */
import { httpRequest } from '../src/http.mjs';

const SITE = process.env.IP_AUTO_SITE || 'https://jhz1053962051-sketch.github.io/ip-auto';

// 不加 ?t= 打散缓存：GitHub Pages 对「目录 URL + query」会回 404（实测 /ip-auto/?t=... → 404），
// 而 /ip-auto/ 本身是 200。缓存用请求头绕，别动 URL。
async function get(pathname) {
  const t0 = Date.now();
  const r = await httpRequest(`${SITE}${pathname}`, {
    timeoutMs: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 ip-auto-verify', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  return { status: r.status, body: r.body, ms: Date.now() - t0 };
}

const html = await get('/');
const data = await get('/data.json');

console.log(`index.html  HTTP ${html.status}  ${html.body.length}B  ${html.ms}ms`);
console.log(`data.json   HTTP ${data.status}  ${data.body.length}B  ${data.ms}ms`);

const checks = [
  ['页面有「欺诈分」表头', html.body.includes('欺诈分</th>')],
  ['页面有「住宅」不等于「干净」说明', html.body.includes('不等于')],
  ['页面有欺诈分统计卡', html.body.includes('欺诈分中位数')],
  ['页面有 fraud 单元格', /<span class="fraud [a-z]+"/.test(html.body)],
];

let bad = 0;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${n}`);
  if (!ok) bad++;
}

let j = null;
try {
  j = JSON.parse(data.body);
} catch (e) {
  console.log('  ✗ data.json 不是合法 JSON');
  bad++;
}

if (j) {
  const s = j.stats || {};
  console.log(
    `\nstats: nodes=${s.success} purity=${s.purity_measured} fraud_median=${s.fraud_median} ` +
      `clean=${s.fraud_clean} dirty=${s.fraud_dirty} bad=${s.fraud_bad} real_median=${s.real_ms_median}`
  );
  const v = j.vless_nodes || [];
  const withFraud = v.filter((n) => Number.isFinite(n.fraud)).length;
  console.log(`vless_nodes ${v.length} 条，其中带 fraud ${withFraud} 条`);
  const top = v.filter((n) => Number.isFinite(n.fraud)).sort((a, b) => b.fraud - a.fraud).slice(0, 5);
  console.log('最脏 5 个：');
  for (const n of top) console.log(`   ${String(n.fraud).padStart(3)} ${n.name} ${n.fraud_risk || ''} ${n.real_ip || n.exit_ip}`);
  const clean = v.filter((n) => Number.isFinite(n.fraud)).sort((a, b) => a.fraud - b.fraud).slice(0, 5);
  console.log('最干净 5 个：');
  for (const n of clean) console.log(`   ${String(n.fraud).padStart(3)} ${n.name} ${n.fraud_risk || ''} ${n.real_ip || n.exit_ip}`);
}

process.exit(bad ? 1 : 0);