import { connectTcp, tlsUpgrade } from '../src/http.mjs';
const W='ipauto-edgetunnel.jhz1053962051.workers.dev';
const cases=[
 ['104.16.132.229',W],
 ['172.64.156.171',W],
 ['104.16.132.229','abc.workers.dev'],
 ['104.16.132.229','cloudflare.com'],
];
for(const [host,sni] of cases){
  const t0=Date.now();
  try{ const raw=await connectTcp(host,443,null,8000); const s=await tlsUpgrade(raw,sni,8000); s.destroy();
    console.log(`✅ ${String(Date.now()-t0).padStart(5)}ms  ${host}  SNI=${sni}`); }
  catch(e){ console.log(`❌ ${String(Date.now()-t0).padStart(5)}ms  ${host}  SNI=${sni} → ${e.message.slice(0,40)}`); }
}
