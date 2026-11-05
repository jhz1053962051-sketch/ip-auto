/** 判断直连失败是「IP 不通」还是「SNI 被封」 */
import { connectTcp, tlsUpgrade } from '../src/http.mjs';
const cases = [
  ['saas.sin.fan', 443, 'saas.sin.fan'],
  ['saas.sin.fan', 443, 'ipauto-edgetunnel.jhz1053962051.workers.dev'],
  ['www.visa.com.sg', 443, 'www.visa.com.sg'],
  ['172.64.156.171', 443, 'saas.sin.fan'],
  ['172.64.156.171', 443, 'ipauto-edgetunnel.jhz1053962051.workers.dev'],
  ['104.16.132.229', 443, 'cloudflare.com'],
];
for (const [host, port, sni] of cases) {
  const t0 = Date.now();
  try {
    const raw = await connectTcp(host, port, null, 8000);
    const s = await tlsUpgrade(raw, sni, 8000);
    s.destroy();
    console.log(`✅ ${String(Date.now() - t0).padStart(5)}ms  ${host}:${port}  SNI=${sni}`);
  } catch (e) {
    console.log(`❌ ${String(Date.now() - t0).padStart(5)}ms  ${host}:${port}  SNI=${sni}  → ${e.message.slice(0, 44)}`);
  }
}
