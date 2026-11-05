/**
 * 出口 IP 归属判定：国家 / ASN / 住宅 or 机房。
 *
 * 数据源优先级：
 *   1. ip-api.com/batch（免费、支持批量、返回 hosting/proxy/mobile/reverse）
 *   2. ipinfo.io/<ip>/json（兜底，逐条）
 *   3. 本地启发式（hostname 前缀 + org 关键字）
 */
import { httpRequest } from './http.mjs';

const IPAPI_BATCH = 'http://ip-api.com/batch';
const IPAPI_FIELDS =
  'status,message,country,countryCode,regionName,city,isp,org,as,asname,hosting,proxy,mobile,reverse';

/** 机房类 org 关键字（命中即判为机房） */
const DC_KEYWORDS = [
  'AMAZON', 'AWS', 'GOOGLE', 'MICROSOFT', 'AZURE', 'CLOUDFLARE', 'DIGITALOCEAN', 'LINODE',
  'VULTR', 'HETZNER', 'OVH', 'CONTABO', 'ORACLE', 'ALIBABA', 'TENCENT', 'CHOOPA', 'M247',
  'DATACAMP', 'LEASEWEB', 'SERVERIUS', 'COLOCO', 'PSYCHZ', 'AKAMAI', 'FASTLY', 'G-CORE',
  'SCALEWAY', 'UPCLOUD', 'IONOS', 'EQUINIX', 'ZENLAYER', 'BANDWAGON', 'RAMNODE', 'HOSTING',
  'DATACENTER', 'DATA CENTER', 'SERVER', 'VPS', 'CLOUD',
];

/** 住宅类 org 关键字（命中即判为住宅/家宽） */
const RESI_KEYWORDS = [
  'SOFTETHER', 'VPN GATE', 'VGATE', 'NTT', 'KDDI', 'SOFTBANK', 'OCN', 'BIGLOBE', 'PLALA',
  'COMMUF@', 'ARTERIA', 'KOREA TELECOM', 'KT ', 'SK BROADBAND', 'SK TELECOM', 'LG U+',
  'LG POWERCOMM', 'HELLO VISION', 'SKYLIFE', 'BROADBAND', 'FIBER', 'HIKARI', 'HINET',
  'CHINANET', 'COMCAST', 'VERIZON', 'AT&T', 'SPECTRUM', 'CENTURYLINK', 'TELSTRA',
];

export function classifyByOrg(org) {
  const o = String(org || '').toUpperCase();
  if (!o) return 'unknown';
  if (DC_KEYWORDS.some((k) => o.includes(k))) return 'datacenter';
  if (RESI_KEYWORDS.some((k) => o.includes(k))) return 'residential';
  return 'unknown';
}

/** hostname 启发式（VPN Gate 节点名规律） */
export function classifyByHost(host) {
  const h = String(host || '').toLowerCase();
  if (/^public-vpn/.test(h) || /^public-nat/.test(h)) return 'datacenter';
  if (/^vpnv\d+/.test(h) || /^vpn\d{5,}/.test(h)) return 'residential';
  return 'unknown';
}

/**
 * 综合判定。isHosting 来自 ip-api 的 hosting 字段：
 * true → 机房；false → 非机房（视为住宅出口）。
 */
export function decide({ host, org, isHosting }) {
  if (isHosting === true) return 'datacenter';
  if (isHosting === false) return 'residential';
  const byOrg = classifyByOrg(org);
  if (byOrg !== 'unknown') return byOrg;
  return classifyByHost(host);
}

/**
 * 批量查询 IP 归属。ip-api 免费额度 45 次/分钟（批量接口按 IP 数计）。
 * @param {string[]} ips
 * @param {{proxy?:object, timeoutMs?:number, chunk?:number}} opt
 * @returns {Promise<Map<string, object>>}
 */
export async function lookupIps(ips, opt = {}) {
  const { proxy = null, timeoutMs = 20000, chunk = 90 } = opt;
  const uniq = [...new Set(ips.filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < uniq.length; i += chunk) {
    const part = uniq.slice(i, i + chunk);
    const payload = JSON.stringify(part.map((q) => ({ query: q, fields: IPAPI_FIELDS })));
    try {
      const r = await httpRequest(IPAPI_BATCH, {
        proxy,
        method: 'POST',
        body: payload,
        timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
          Accept: 'application/json',
        },
      });
      if (r.status !== 200) throw new Error(`ip-api HTTP ${r.status}`);
      const arr = JSON.parse(r.body);
      if (!Array.isArray(arr)) throw new Error('ip-api 返回格式异常');
      arr.forEach((it, k) => {
        const ip = part[k] || it.query;
        map.set(ip, it);
      });
    } catch (e) {
      // 单批失败不影响整体，交给上层用启发式兜底
      for (const ip of part) map.set(ip, { status: 'fail', error: e?.message || String(e) });
    }
    if (i + chunk < uniq.length) await new Promise((r) => setTimeout(r, 1500));
  }
  return map;
}

/** 把 ip-api 记录整理成本项目使用的 exit 结构 */
export function normalizeExit(ip, rec, host) {
  if (!rec || rec.status !== 'success') {
    return {
      ip,
      country: null,
      country_code: null,
      city: null,
      isp: null,
      org: null,
      asn: null,
      asname: null,
      is_hosting: null,
      residential: classifyByHost(host),
      lookup_error: rec?.error || rec?.message || 'lookup-failed',
    };
  }
  const asnMatch = String(rec.as || '').match(/^(AS\d+)\s+(.*)$/i);
  const org = rec.org || rec.isp || '';
  return {
    ip,
    country: rec.country || null,
    country_code: (rec.countryCode || '').toUpperCase() || null,
    region: rec.regionName || null,
    city: rec.city || null,
    isp: rec.isp || null,
    org,
    asn: asnMatch ? asnMatch[1] : rec.as || null,
    asname: rec.asname || (asnMatch ? asnMatch[2] : null),
    is_hosting: typeof rec.hosting === 'boolean' ? rec.hosting : null,
    is_proxy: typeof rec.proxy === 'boolean' ? rec.proxy : null,
    reverse: rec.reverse || null,
    residential: decide({ host, org, isHosting: rec.hosting }),
  };
}
