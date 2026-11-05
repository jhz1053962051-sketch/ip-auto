/**
 * 验证「入口域名」是否可用：以每个优选入口域名为 TCP 目标，
 * 但 TLS SNI 固定用我们自己的 Worker 域名（edgetunnel 生成的节点就是这样用的：
 * sni/host 都被改写成 worker 域名，入口域名只负责提供可解析的 Cloudflare anycast IP）。
 *
 * 所以判断标准不是「域名本身能不能访问」，而是「它的 IP 能不能承载我们的 SNI」。
 *
 * 用法:
 *   node test/edge-entry-check.mjs [sni] [host,host,...]
 */
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { EDGE_HOSTS } from '../src/edges.mjs';

const SNI = process.argv[2] || 'ipauto-edge.pages.dev';
const UUID = process.env.IP_AUTO_UUID || '2900cf6a-b708-4358-8d38-189a4ad4cae7';
const TIMEOUT = Number(process.env.TIMEOUT_MS || 7000);

const hosts = (process.argv[3] ? process.argv[3].split(',') : EDGE_HOSTS)
  .map((h) => String(h).replace(/:443$/, '').trim())
  .filter(Boolean);

function probe(host) {
  return new Promise(async (resolve) => {
    let ips = [];
    const t0 = Date.now();
    try {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) ips = [host];
      else ips = await dns.resolve4(host);
    } catch (e) {
      return resolve({ host, ok: false, ms: Date.now() - t0, msg: `DNS ${e.code || e.message}` });
    }
    const ip = ips[0];
    const sock = tls.connect({ host: ip, port: 443, servername: SNI });
    let buf = '';
    const done = (ok, msg) => { try { sock.destroy(); } catch {} resolve({ host, ip, ok, ms: Date.now() - t0, msg }); };
    sock.setTimeout(TIMEOUT + 8000, () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code || e.message));
    sock.once('secureConnect', () => {
      sock.write(`GET /version?uuid=${UUID} HTTP/1.1\r\nHost: ${SNI}\r\nUser-Agent: probe\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { buf += d.toString('latin1'); });
    sock.on('end', () => {
      const first = buf.split('\r\n')[0] || '';
      const body = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      done(/200/.test(first) && /Version/.test(body), `${first.replace('HTTP/1.1 ', '')} ${body.slice(0, 40)}`);
    });
  });
}

console.log(`SNI=${SNI}  入口 ${hosts.length} 个\n`);
const rows = await Promise.all(hosts.map(probe));
rows.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms);
for (const r of rows) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.host.padEnd(22)} ${(r.ip || '-').padEnd(16)} ${String(r.ms).padStart(6)}ms  ${r.msg}`);
}
const ok = rows.filter((r) => r.ok).map((r) => `${r.host}:443`);
console.log(`\n可用入口 ${ok.length}/${rows.length}`);
if (ok.length) console.log(ok.join('\n'));
