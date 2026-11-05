/**
 * 测「固定 Cloudflare 边缘 IP + pages.dev SNI」是否可作为直连入口。
 *
 * 背景：本机对 *.workers.dev 做 SNI 阻断，对部分优选域名也 ECONNRESET。
 * edgetunnel 生成的节点里 sni/host 都会被改写成 Worker 自己的域名（ipauto-edge.pages.dev），
 * 所以真正决定能不能连的只有「TCP 目标地址」。这里逐个试固定 IP，
 * 找出既通、延迟又低的那几个，用来替换 nodes.txt 里那些连不上的入口域名。
 *
 * 用法:
 *   node test/edge-ip-probe.mjs [ip,ip,...]
 */
import tls from 'node:tls';
import net from 'node:net';
import dns from 'node:dns/promises';

const SNI = process.env.SNI || 'ipauto-edge.pages.dev';
const TIMEOUT = Number(process.env.TIMEOUT_MS || 6000);

const DEFAULTS = [
  '172.64.156.171',
  '104.21.0.1',
  '172.67.0.1',
  '104.26.10.209',
  '172.67.74.209',
  '162.159.140.98',
  '172.66.0.96',
  '104.16.0.1',
];

function tlsProbe(ip, servername) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = tls.connect({ host: ip, port: 443, servername, servername, rejectUnauthorized: false });
    const done = (ok, msg) => { try { sock.destroy(); } catch {} resolve({ ok, ms: Date.now() - t0, msg }); };
    sock.setTimeout(TIMEOUT, () => done(false, 'timeout'));
    sock.once('secureConnect', () => done(true, `alpn=${sock.alpnProtocol || '-'} proto=${sock.getProtocol()}`));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

async function httpProbe(ip) {
  // 握手成功后验证 CF 真的按 SNI 路由到了我们的 Pages 项目
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = tls.connect({ host: ip, port: 443, servername: SNI });
    let buf = '';
    const done = (ok, msg) => { try { sock.destroy(); } catch {} resolve({ ok, ms: Date.now() - t0, msg }); };
    sock.setTimeout(TIMEOUT + 6000, () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code || e.message));
    sock.once('secureConnect', () => {
      sock.write(`GET /version?uuid=2900cf6a-b708-4358-8d38-189a4ad4cae7 HTTP/1.1\r\nHost: ${SNI}\r\nUser-Agent: probe\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { buf += d.toString('latin1'); });
    sock.on('end', () => {
      const first = buf.split('\r\n')[0] || '';
      const body = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      done(/200/.test(first), `${first} ${body.slice(0, 60).replace(/\s+/g, ' ')}`);
    });
  });
}

const list = (process.argv[2] ? process.argv[2].split(',') : DEFAULTS).map((s) => s.trim()).filter(Boolean);

// 顺带把入口域名解析出来的 IP 也加进来
if (!process.argv[2]) {
  for (const h of ['ipauto-edge.pages.dev', 'saas.sin.fan']) {
    try {
      const a = await dns.resolve4(h);
      for (const ip of a) if (!list.includes(ip)) list.push(`${ip}`);
    } catch (e) { console.log(`解析 ${h} 失败: ${e.code || e.message}`); }
  }
}

console.log(`SNI=${SNI}  候选 ${list.length} 个\n`);
const rows = await Promise.all(list.map(async (ip) => ({ ip, tls: await tlsProbe(ip, SNI), http: null })));
await Promise.all(rows.filter((r) => r.tls.ok).map(async (r) => { r.http = await httpProbe(r.ip); }));

rows.sort((a, b) => Number(b.http?.ok || 0) - Number(a.http?.ok || 0) || a.tls.ms - b.tls.ms);
for (const r of rows) {
  const t = r.tls.ok ? `✅${String(r.tls.ms).padStart(5)}ms` : `❌${String(r.tls.ms).padStart(5)}ms ${r.tls.msg}`;
  const h = r.http ? (r.http.ok ? `  HTTP✅ ${r.http.msg}` : `  HTTP❌ ${r.http.msg}`) : '';
  console.log(`${r.ip.padEnd(18)} ${t}${h}`);
}
const good = rows.filter((r) => r.http?.ok).map((r) => r.ip);
console.log(`\n可用入口 IP: ${good.length}/${rows.length}`);
if (good.length) console.log(good.map((ip) => `${ip}:443`).join(','));
