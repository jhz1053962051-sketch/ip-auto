/** 测试 public/nodes.txt 里的入口域名，经本地代理 7897 是否可达（TLS 直连） */
import { connectTcp, tlsUpgrade, parseProxy } from '../src/http.mjs';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const PROXY = parseProxy(process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897');
const SNI = process.env.IP_AUTO_SNI || 'ipauto-edgetunnel.jhz1053962051.workers.dev';
const useProxy = process.env.IP_AUTO_DIRECT !== '1';
const hosts = [...new Set(fs.readFileSync(path.join(ROOT, 'public/nodes.txt'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => l.split('#')[0]))];
const out = [];
await Promise.all(hosts.map(async (h) => {
  const [host, port = '443'] = h.split(':');
  const t0 = Date.now();
  try {
    const raw = await connectTcp(host, Number(port), useProxy ? PROXY : null, 8000);
    const s = await tlsUpgrade(raw, SNI, 8000);
    s.destroy();
    out.push({ h, ms: Date.now() - t0, ok: true });
  } catch (e) { out.push({ h, ms: Date.now() - t0, ok: false, err: e.message.slice(0, 46) }); }
}));
out.sort((a, b) => (b.ok - a.ok) || (a.ms - b.ms));
for (const o of out) console.log(`${o.ok ? '✅' : '❌'} ${o.h.padEnd(34)} ${String(o.ms).padStart(5)}ms ${o.ok ? '' : ' ' + o.err}`);
console.log(`\n${useProxy ? '经代理 7897' : '直连'} 可用 ${out.filter((o) => o.ok).length}/${out.length}`);
