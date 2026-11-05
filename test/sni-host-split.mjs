/**
 * 关键探测：TLS 用「不被墙的 SNI」，HTTP Host 头写 workers.dev 域名。
 * 如果 Cloudflare 按 Host 路由 worker，这条路就能绕过 workers.dev 的 SNI 封锁。
 */
import { connectTcp, tlsUpgrade } from '../src/http.mjs';
const W = 'ipauto-edgetunnel.jhz1053962051.workers.dev';
const cases = [
  ['saas.sin.fan', 443, 'saas.sin.fan', W],
  ['www.visa.com.sg', 443, 'www.visa.com.sg', W],
  ['172.64.156.171', 443, 'saas.sin.fan', W],
];
for (const [host, port, sni, hostHeader] of cases) {
  try {
    const raw = await connectTcp(host, port, null, 8000);
    const s = await tlsUpgrade(raw, sni, 8000);
    s.write(`GET / HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n`, 'latin1');
    let buf = Buffer.alloc(0);
    await new Promise((r) => { s.on('data', (c) => { buf = Buffer.concat([buf, c]); if (buf.length > 900) r(); }); s.on('end', r); s.on('close', r); setTimeout(r, 6000); });
    s.destroy();
    const head = buf.subarray(0, 260).toString('utf8').replace(/\r\n/g, ' | ');
    console.log(`SNI=${sni.padEnd(16)} Host=${hostHeader.slice(0, 30)}…`);
    console.log(`   → ${head.slice(0, 200)}`);
    const st = (buf.toString('utf8').match(/^HTTP\/1\.1 (\d+)/) || [])[1];
    console.log(`   状态: ${st || '无响应'}  字节: ${buf.length}`);
  } catch (e) { console.log(`SNI=${sni} Host=${hostHeader.slice(0, 24)}… → 失败: ${e.message.slice(0, 50)}`); }
}
