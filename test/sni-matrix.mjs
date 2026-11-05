/** 固定 IP（172.64.156.171 = Cloudflare），换不同 SNI，判断是不是 SNI 级封锁 */
import { connectTcp, tlsUpgrade } from '../src/http.mjs';
const IP = '172.64.156.171';
const snis = [
  'saas.sin.fan', 'www.visa.com.sg', 'cloudflare.com', 'dash.cloudflare.com',
  'ipauto-edgetunnel.jhz1053962051.workers.dev', 'foo.workers.dev',
  'jhz1053962051-sketch.github.io', 'abc.pages.dev', 'nonexistent-random-xyz.example',
  'www.bing.com',
];
for (const sni of snis) {
  const t0 = Date.now();
  try {
    const raw = await connectTcp(IP, 443, null, 7000);
    const s = await tlsUpgrade(raw, sni, 7000);
    s.destroy();
    console.log(`✅ ${String(Date.now() - t0).padStart(5)}ms  ${sni}`);
  } catch (e) { console.log(`❌ ${String(Date.now() - t0).padStart(5)}ms  ${sni.padEnd(46)} ${e.message.slice(0, 34)}`); }
}
