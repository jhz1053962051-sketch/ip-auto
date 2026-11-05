/**
 * 试探：JP/KR 的公共代理池里有没有「住宅 + 低延迟」的 socks5/http 代理。
 *
 * 动机：SSTP 链路每次新建连接都要走 TLS + PPP(LCP/PAP/IPCP) 协商，Worker 侧实测
 * 建链普遍 1.8~2.5s —— 这是协议成本，换节点只能优化一小部分。而 socks5/http 链式代理
 * 只有一次握手（几百毫秒）。如果能在日韩找到住宅出口的 socks5/http，延迟能直接砍掉一大截。
 *
 * 用法：node test/proxy-jpkr.mjs [--countries JP,KR] [--max 400]
 */
import { collectProxyNodes } from '../src/proxynodes.mjs';
import { parseProxy } from '../src/http.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const countries = String(arg('countries', 'JP,KR')).split(',').map((s) => s.trim().toUpperCase());
const max = Number(arg('max', '400'));
const proxy = parseProxy(process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897');

const t0 = Date.now();
const { nodes, stats } = await collectProxyNodes(countries, {
  proxy,
  concurrency: 32,
  timeoutMs: 10000,
  maxPerCountry: max,
  log: (m) => console.log(m),
});

console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('stats', JSON.stringify(stats));
console.log(`\n节点 ${nodes.length} 个：`);
const resi = nodes.filter((n) => n.residential === 'residential');
for (const n of nodes.sort((a, b) => (a.latency_ms || 1e9) - (b.latency_ms || 1e9))) {
  console.log(
    `  ${n.residential === 'residential' ? '住宅' : '机房'} ${String(n.latency_ms).padStart(5)}ms ` +
      `${n.protocol.padEnd(6)} ${n.country_code} ${n.exit_ip.padEnd(15)} ${String(n.org || '').slice(0, 40)}`
  );
}
console.log(`\n住宅 ${resi.length} / 共 ${nodes.length}`);
