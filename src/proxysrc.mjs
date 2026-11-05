/**
 * 公共代理池数据源：为 VPN Gate 覆盖不到的国家（典型：新加坡）补充节点。
 *
 * 背景：
 *   VPN Gate 的节点是志愿者贡献的，长期以日本/韩国为主，新加坡常年为 0。
 *   而 edgetunnel 的链式代理支持 socks5 / http / https / turn / sstp 五种协议，
 *   所以只要拿到任意国家的 socks5/http 代理，就能作为链式代理出口。
 *
 * 现实约束（实测，不要抱幻想）：
 *   公共代理池里的「新加坡」几乎全是机房 IP —— 腾讯云 / 阿里云 / DigitalOcean /
 *   OVH / Oracle / Azure / Akamai。真实住宅 IP 极少且存活时间以小时计。
 *   实测 190 个候选组合里存活 4 个、SG 出口 3 个、住宅 0 个。
 *   因此本模块产出的节点会被 geo.mjs 标成「机房」，页面与订阅都会如实标注。
 */
import { httpRequest } from './http.mjs';

/** 每个源：{ name, url(cc, page), kind } */
export const PROXY_SOURCES = [
  {
    name: 'proxyscrape',
    kind: 'text',
    url: (cc) => `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${cc}&proxy_format=ipport&format=text`,
  },
  {
    name: 'geonode',
    kind: 'geonode',
    pages: 3,
    url: (cc, page) =>
      `https://proxylist.geonode.com/api/proxy-list?limit=100&page=${page}&sort_by=lastChecked&sort_type=desc&country=${cc}`,
  },
];

const IPPORT = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/;

/** 抓取一个国家的代理候选（去重，协议待探测时再试） */
export async function fetchProxyCandidates(country, opt = {}) {
  const { proxy = null, timeoutMs = 25000, log = () => {} } = opt;
  const cc = String(country || '').toUpperCase();
  const out = new Set();
  const errors = [];

  for (const src of PROXY_SOURCES) {
    const pages = src.kind === 'geonode' ? src.pages : 1;
    for (let page = 1; page <= pages; page++) {
      const url = src.url(cc, page);
      try {
        const r = await httpRequest(url, {
          proxy,
          timeoutMs,
          headers: { accept: 'text/plain, application/json', 'user-agent': 'ip-auto/1.0' },
        });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        if (src.kind === 'geonode') {
          const data = JSON.parse(r.body);
          for (const it of data.data || []) {
            if (IPPORT.test(`${it.ip}:${it.port}`)) out.add(`${it.ip}:${it.port}`);
          }
        } else {
          for (const line of r.body.split(/\r?\n/)) {
            const s = line.trim().replace(/^(socks5|socks4|http|https):\/\//i, '');
            if (IPPORT.test(s)) out.add(s);
          }
        }
        log(`[proxy:${src.name}] ${cc} p${page} → 累计 ${out.size}`);
      } catch (e) {
        errors.push(`${src.name}: ${e?.message || e}`);
        log(`[proxy:${src.name}] ${cc} p${page} 失败 ${e?.message || e}`);
      }
    }
  }
  return { country: cc, candidates: [...out], errors };
}

/** 批量抓取多个国家 */
export async function fetchAllCandidates(countries, opt = {}) {
  const out = [];
  for (const cc of countries) out.push(await fetchProxyCandidates(cc, opt));
  return out;
}
