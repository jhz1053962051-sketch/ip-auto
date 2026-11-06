/**
 * Scamalytics 抓取限速/并发可行性测试。
 * 关心的只有一件事：连打多个 IP 会不会被 429 / Cloudflare 挑战页挡住。
 *   $env:https_proxy="http://127.0.0.1:7897"; node test/scam-rate.mjs
 */
import { httpRequest } from '../src/http.mjs';

const PROXY = process.env.https_proxy ? { host: '127.0.0.1', port: 7897 } : null;

const IPS = [
  '121.118.241.33', '222.111.130.73', '126.99.142.181', '219.100.37.233',
  '106.179.237.234', '180.45.106.251', '115.39.201.6', '153.174.22.211',
  '126.72.223.237', '60.60.15.130',
];

function parse(html) {
  const fraud = (html.match(/Fraud Score:\s*<\/?[^>]*>?\s*(\d+)/) || html.match(/Fraud Score[^0-9]{0,80}(\d+)/) || [])[1];
  const risk = (html.match(/potentially\s*<b>([a-z]+)<\/b>\s*fraud risk/i) || [])[1] || null;
  const challenging = /Just a moment|cf-challenge|Enable JavaScript and cookies/i.test(html);
  return { fraud: fraud == null ? null : Number(fraud), risk, challenging, len: html.length };
}

async function one(ip, idx) {
  const t0 = Date.now();
  try {
    const r = await httpRequest(`https://scamalytics.com/ip/${ip}`, {
      proxy: PROXY,
      timeoutMs: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const p = parse(r.body);
    console.log(`#${String(idx).padStart(2)} ${ip.padEnd(16)} HTTP ${r.status} ${String(Date.now() - t0).padStart(5)}ms  fraud=${p.fraud} risk=${p.risk} challenge=${p.challenging} len=${p.len}`);
    return { ip, ok: r.status === 200 && p.fraud != null, fraud: p.fraud, risk: p.risk, challenge: p.challenging };
  } catch (e) {
    console.log(`#${String(idx).padStart(2)} ${ip.padEnd(16)} 失败: ${e.message}`);
    return { ip, ok: false };
  }
}

async function main() {
  console.log('== 串行 3 个（测基线）==');
  for (let i = 0; i < 3; i++) await one(IPS[i], i + 1);

  console.log('\n== 并发 4（测限速）==');
  let n = 0;
  const q = IPS.slice(3);
  const workers = Array.from({ length: 4 }, async () => {
    while (q.length) {
      const ip = q.shift();
      await one(ip, ++n + 3);
    }
  });
  const res = await Promise.all(workers);
  const okAll = res.flat?.() || [];
  console.log(`\n并发段完成 ${n} 个`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
