/**
 * 纯净度解析 + 批量查询自测。
 *   $env:https_proxy="http://127.0.0.1:7897"; node test/purity-unit.mjs
 */
import { parseScamalytics, probePurity, purityLevel, purityStats } from '../src/purity.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name} ${extra}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// 真实页面片段（取自 218.131.41.95 的实测 HTML）
const DIRTY = `<div class="score_bar"> <div>0</div> <div class="score">Fraud Score: 100</div> <div>100</div> </div>
</div><div class="panel_body">We consider <b>web traffic</b> from IP address <b>218.131.41.95</b> to present a potentially <b>very high</b> fraud risk. This IP address is operated by <b>SOFTBANK Corp</b> whose web traffic we consider to present a potentially <b>low</b> fraud risk, and is owned by <b>SoftBank Corp.</b> whose web traffic we also consider to present a potentially <b>low</b> fraud risk.</div>`;

const CLEAN = `<div class="panel_body">IP address <b>8.209.255.13</b> is operated by <b>Alibaba.com Singapore E-Commerce Private Limited</b> whose <b>web traffic</b> we consider to present a potentially <b>low</b> fraud risk. Non-web traffic may present a different risk or no risk at all. We have no visibility into the web traffic directly from <b>8.209.255.13</b>, and therefore apply a risk score of 0/100 based on the overall risk from <b>Alibaba.com Singapore E-Commerce Private Limited</b>’s IP addresses where we do have visibility.</div>`;

const CHALLENGE = `<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>`;

console.log('--- 解析器单测 ---');
const d = parseScamalytics(DIRTY);
ok('脏 IP fraud=100', d.fraud === 100, JSON.stringify(d));
ok('脏 IP risk=very high（不是运营商那句 low）', d.risk === 'very high', `risk=${d.risk}`);
ok('脏 IP risk_scope=ip', d.risk_scope === 'ip', `scope=${d.risk_scope}`);
ok('脏 IP operator', d.operator === 'SOFTBANK Corp', `op=${d.operator}`);

const c = parseScamalytics(CLEAN);
ok('干净 IP fraud=0（走 apply a risk score of 0/100）', c.fraud === 0, JSON.stringify(c));
ok('干净 IP risk=low', c.risk === 'low', `risk=${c.risk}`);
ok('干净 IP risk_scope=operator（页面没有该 IP 的直接观测）', c.risk_scope === 'operator', `scope=${c.risk_scope}`);
ok('干净 IP operator', c.operator === 'Alibaba.com Singapore E-Commerce Private Limited', `op=${c.operator}`);

const ch = parseScamalytics(CHALLENGE);
ok('挑战页 fraud=null', ch.fraud === null);
ok('挑战页 challenge=true', ch.challenge === true);

ok('空串不炸', parseScamalytics('').fraud === null);

console.log('\n--- 分档 ---');
for (const [v, want] of [[0, 'clean'], [24, 'clean'], [25, 'fair'], [49, 'fair'], [50, 'dirty'], [74, 'dirty'], [75, 'bad'], [100, 'bad']]) {
  const l = purityLevel(v);
  ok(`fraud=${v} → ${want}`, l && l.key === want, `got=${l && l.key}`);
}
ok('fraud=null → null', purityLevel(null) === null);

console.log('\n--- 统计 ---');
const st = purityStats([{ fraud: 0 }, { fraud: 10 }, { fraud: 60 }, { fraud: 100 }, { fraud: null }, {}]);
ok('measured=4', st.purity_measured === 4, JSON.stringify(st));
ok('median=35', st.fraud_median === 35, JSON.stringify(st));
ok('clean=2 (0,10)', st.fraud_clean === 2, JSON.stringify(st));
ok('dirty=2 (60,100)', st.fraud_dirty === 2, JSON.stringify(st));

console.log('\n--- 线上实查 3 个 IP ---');
for (const ip of ['218.131.41.95', '8.209.255.13', '219.100.37.245']) {
  const r = await probePurity(ip, { proxy: process.env.https_proxy ? { host: '127.0.0.1', port: 7897 } : null });
  console.log(`  ${ip.padEnd(16)} ok=${r.ok} fraud=${r.fraud} risk=${r.risk} op=${(r.operator || '').slice(0, 32)} ${r.ms}ms ${r.error || ''}`);
  ok(`线上 ${ip} 可查`, r.ok === true);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
