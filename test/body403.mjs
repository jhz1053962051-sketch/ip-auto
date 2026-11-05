import { connectTcp, tlsUpgrade } from '../src/http.mjs';
const raw = await connectTcp('172.64.156.171', 443, null, 8000);
const s = await tlsUpgrade(raw, 'saas.sin.fan', 8000);
s.write(`GET / HTTP/1.1\r\nHost: ipauto-edgetunnel.jhz1053962051.workers.dev\r\nConnection: close\r\nUser-Agent: Mozilla/5.0\r\n\r\n`, 'latin1');
let b = Buffer.alloc(0);
await new Promise((r) => { s.on('data', (c) => b = Buffer.concat([b, c])); s.on('end', r); s.on('close', r); setTimeout(r, 6000); });
s.destroy();
console.log(b.toString('utf8').slice(0, 800));
