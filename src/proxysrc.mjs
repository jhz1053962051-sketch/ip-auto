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
 *   因此本模块产出的节点会被 geo.mjs 标成「机房」，页面与订阅都会如实标注。
 *
 * 数据源实测（`test/proxy-sources.mjs`，2026-11-05，走 127.0.0.1:7897）：
 *   proxifly  countries/SG/data.txt   205 条（带 socks5:// https:// 前缀）★ 最佳
 *   proxifly  countries/JP/data.txt   141 条
 *   proxyscrape v4                    23~27 条（每国），稳定
 *   geonode                           HTTP 200 但 data 为空，已基本不可用
 *   TheSpeedX / hookzof / zloi        几千条全球列表，**不带国家**，需先反查地理，成本高
 *   monosans / proxy-list.download    404 / 502，弃用
 * 所以按国家取候选只用 proxifly + proxyscrape 两个。
 */
import { httpRequest } from './http.mjs';

/** 每个源：{ name, url(cc), kind } —— kind: 'text' 纯文本 / 'geonode' JSON */
export const PROXY_SOURCES = [
  {
    name: 'proxifly',
    kind: 'text',
    // jsDelivr 镜像比 raw.githubusercontent 稳（后者在本机偶发 TLS 中断）
    url: (cc) => `https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/${cc}/data.txt`,
    keepPrefix: true,
  },
  {
    name: 'proxyscrape',
    kind: 'text',
    url: (cc) => `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${cc}&proxy_format=ipport&format=text`,
  },
  {
    name: 'proxyscrape-v3',
    kind: 'text',
    url: (cc) => `https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&country=${cc}&proxy_format=ipport&format=text`,
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
    const url = src.url(cc, 1);
    try {
      const r = await httpRequest(url, {
        proxy,
        timeoutMs,
        headers: { accept: 'text/plain, application/json', 'user-agent': 'curl/8.4.0' },
      });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      let added = 0;
      for (const line of String(r.body || '').split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw) continue;
        // 保留 `socks5://` / `https://` 前缀：proxifly 明确标了协议，探测时优先按它试
        const m = /^(socks5|socks4|http|https):\/\/(.+)$/i.exec(raw);
        const body = m ? m[2] : raw;
        if (!IPPORT.test(body)) continue;
        out.add(m ? `${m[1].toLowerCase()}://${body}` : body);
        added++;
      }
      log(`[proxy:${src.name}] ${cc} → +${added}，累计 ${out.size}`);
    } catch (e) {
      errors.push(`${src.name}: ${e?.message || e}`);
      log(`[proxy:${src.name}] ${cc} 失败 ${e?.message || e}`);
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
