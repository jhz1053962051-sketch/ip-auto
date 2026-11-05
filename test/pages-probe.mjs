/** pages.dev 是否真的可访问（不只是 TLS 握手） */
import { connectTcp, tlsUpgrade } from '../src/http.mjs';
const cases = [
  ['abc.pages.dev', 'abc.pages.dev', null],
  ['ip-auto.pages.dev', 'ip-auto.pages.dev', null],
  ['172.64.156.171', 'abc.pages.dev', null],
];
for (const [host, sni] of cases) {
  const t0 = Date.now();
  try {
    const raw = await connectTcp(host, 443, null, 9000);
    const s = await tlsUpgrade(raw, sni, 9000);
    const peer = s.getPeerCertificate?.();
    console.log(`✅ TLS ${String(Date.now() - t0).padStart(5)}ms  ${sni}  证书CN=${peer?.subject?.CN || '?'} SAN含pages.dev=${JSON.stringify(peer?.subjectaltname || '').includes('pages.dev')}`);
    s.write(`GET / HTTP/1.1\r\nHost: ${sni}\r\nConnection: close\r\nUser-Agent: probe\r\n\r\n`, 'latin1');
    let buf = Buffer.alloc(0);
    await new Promise((r) => { s.on('data', (c) => { buf = Buffer.concat([buf, c]); if (buf.length > 400) r(); }); s.on('end', r); s.on('close', r); setTimeout(r, 5000); });
    s.destroy();
    console.log(`   HTTP: ${(buf.toString('utf8').match(/^HTTP\/[\d.]+ (\d+.*)/) || [, '无响应'])[1]?.slice(0, 60)}  ${buf.length}B`);
  } catch (e) { console.log(`❌ ${String(Date.now() - t0).padStart(5)}ms  ${sni} → ${e.message.slice(0, 46)}`); }
}
