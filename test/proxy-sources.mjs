/**
 * 一次性探源：试几个公共代理列表，看哪些在本机能稳定拿到候选。
 * 只负责「能不能拿到 IP:PORT」，不做连通性判断。
 *
 *   node test/proxy-sources.mjs JP KR SG
 */
import { httpRequest } from '../src/http.mjs';
import { parseProxy } from '../src/http.mjs';

const PROXY = parseProxy(process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897');

const SOURCES = [
  ['proxyscrape-v4', (cc) => `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${cc}&proxy_format=ipport&format=text`],
  ['geonode', (cc) => `https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&country=${cc}`],
  ['proxifly-ip', (cc) => `https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/${cc}/data.txt`],
  ['monosans-raw', (cc) => `https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_geolocation/${cc}.txt`],
  ['speedx-socks5', () => 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt'],
  ['speedx-http', () => 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'],
  ['shifty-socks5', () => 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt'],
  ['shifty-http', () => 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'],
  ['hookzof-socks5', () => 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'],
  ['roosterkid-https', () => 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt'],
  ['zloi-socks5', () => 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt'],
  ['zloi-http', () => 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt'],
  ['openproxylist-http', (cc) => `https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt`],
  ['proxy-list-download', (cc) => `https://www.proxy-list.download/api/v1/get?type=http&country=${cc}`],
  ['proxyscrape-v3', (cc) => `https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&country=${cc}&proxy_format=ipport&format=text`],
];

const IPPORT = /(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})/g;

const countries = process.argv.slice(2);
const targets = countries.length ? countries : ['JP', 'KR', 'SG'];

for (const [name, mk] of SOURCES) {
  for (const cc of targets) {
    const url = mk(cc);
    const t0 = Date.now();
    try {
      const r = await httpRequest(url, { proxy: PROXY, timeoutMs: 20000, headers: { 'user-agent': 'curl/8.4.0' } });
      const text = r.body || '';
      const all = [...text.matchAll(IPPORT)].map((m) => `${m[1]}:${m[2]}`);
      const uniq = new Set(all);
      console.log(
        `${name.padEnd(20)} ${cc}  ${String(r.status).padEnd(4)} ${String(uniq.size).padStart(5)} 条  ${Date.now() - t0}ms  ${text.length}B`,
      );
    } catch (e) {
      console.log(`${name.padEnd(20)} ${cc}  FAIL  ${e?.message || e}`);
    }
  }
}
