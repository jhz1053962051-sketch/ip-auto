/**
 * 纯净度探测可行性验证（一次性脚本）。
 *
 * 目的：确认在没有付费 key 的前提下，能拿到哪些「IP 纯净度」信号。
 * 背景：fq-book 的 docs/abc/pure.md 指出「万人骑的 IP」会被风控标记，
 *       判断依据是 IPQualityScore / Scamalytics / AbuseIPDB 的欺诈分 + 是否被判 proxy/VPN。
 *       本项目目前只用 ip-api 的 hosting 字段区分住宅/机房，那是「归属」不是「纯净度」。
 *
 * 结论会写回 README。跑法：
 *   $env:https_proxy="http://127.0.0.1:7897"; node test/purity-probe.mjs
 */
import { httpRequest } from '../src/http.mjs';

const IP = process.argv[2] || '121.118.241.33';
const PROXY = process.env.https_proxy ? { host: '127.0.0.1', port: 7897 } : null;

async function get(url, headers = {}) {
  const t0 = Date.now();
  const r = await httpRequest(url, {
    proxy: PROXY,
    timeoutMs: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...headers },
  });
  return { status: r.status, body: r.body, ms: Date.now() - t0 };
}

async function main() {
  console.log(`目标 IP: ${IP}\n`);

  // 1) Scamalytics：HTML 页面，免费无 key，正则抠 Fraud Score
  try {
    const r = await get(`https://scamalytics.com/ip/${IP}`);
    const m = r.body.match(/Fraud Score:\s*<\/?[^>]*>?\s*(\d+)/) || r.body.match(/Fraud Score[^0-9]{0,80}(\d+)/);
    // 页面里的风险描述形如 "we consider to present a potentially <b>low</b> fraud risk"
    const risk = (r.body.match(/potentially\s*<b>([a-z]+)<\/b>\s*fraud risk/i) || [])[1] || null;
    const op = (r.body.match(/is operated by\s*<b>([^<]+)<\/b>/i) || [])[1] || null;
    console.log(`[scamalytics] HTTP ${r.status} ${r.ms}ms  fraud=${m ? m[1] : '?'}  risk=${risk}  operator=${op}`);
  } catch (e) {
    console.log(`[scamalytics] 失败: ${e.message}`);
  }

  // 2) ipapi.is 免费档：只给 asn/company/location，is_datacenter 等字段要 key
  try {
    const r = await get(`https://api.ipapi.is/?q=${IP}`);
    const j = JSON.parse(r.body);
    const fields = ['is_datacenter', 'is_abuser', 'is_proxy', 'is_vpn', 'is_tor', 'is_crawler'];
    console.log(`[ipapi.is]   HTTP ${r.status} ${r.ms}ms  ${fields.map((f) => `${f}=${j[f]}`).join(' ')}`);
    console.log(`              company=${j.company?.name || j.company}  type=${j.company?.type || '-'}`);
  } catch (e) {
    console.log(`[ipapi.is]   失败: ${e.message}`);
  }

  // 3) ip-api：本项目现有数据源，hosting/proxy/mobile
  try {
    const r = await get(
      `http://ip-api.com/json/${IP}?fields=status,country,countryCode,isp,org,as,hosting,proxy,mobile,reverse`
    );
    const j = JSON.parse(r.body);
    console.log(`[ip-api]     HTTP ${r.status} ${r.ms}ms  hosting=${j.hosting} proxy=${j.proxy} mobile=${j.mobile}`);
    console.log(`              reverse=${j.reverse || '-'}`);
  } catch (e) {
    console.log(`[ip-api]     失败: ${e.message}`);
  }

  // 4) ipinfo 免 key：hostname 里的反向域名是最便宜的「家宽」证据
  try {
    const r = await get(`https://ipinfo.io/${IP}/json`);
    const j = JSON.parse(r.body);
    console.log(`[ipinfo]     HTTP ${r.status} ${r.ms}ms  hostname=${j.hostname || '-'}  org=${j.org || '-'}`);
  } catch (e) {
    console.log(`[ipinfo]     失败: ${e.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
