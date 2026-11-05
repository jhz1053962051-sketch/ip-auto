/**
 * 用 DoH 解析 + 直连 IP，判断「直连 VPN Gate 节点」到底是 DNS 问题还是网络封锁。
 *
 * 上一轮 `test/direct-node.mjs` 对 `vpn600012248.opengw.net` 报 ENOENT（本地 DNS 拿不到
 * *.opengw.net 的 A 记录），这不等于网络不通 —— 7897 是远端解析的，所以经代理能连。
 * 这里先 DoH 拿 IP，再直连 TCP，才能分清：
 *   - DoH 拿到 IP + TCP 连不上  → 网络层真的封了这些段
 *   - DoH 拿到 IP + TCP 连得上  → 只是本地 DNS 不解析，可以用 DoH + hosts 直连跑原生客户端
 *
 * 用法：node test/direct-via-doh.mjs [host] [port]
 */
import net from 'node:net';
import { httpRequest, parseProxy } from '../src/http.mjs';

const DOH = process.env.IP_AUTO_DOH || 'https://dns.google/resolve';

async function resolveA(host, proxy) {
  const url = `${DOH}?name=${encodeURIComponent(host)}&type=A`;
  const r = await httpRequest(url, { proxy, timeoutMs: 15000, headers: { accept: 'application/dns-json' } });
  const j = JSON.parse(r.body);
  return (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
}

function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok, extra = '') => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - started, extra });
    };
    sock.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    sock.once('connect', () => finish(true, 'SYN-ACK'));
    sock.once('error', (e) => finish(false, e.code || String(e.message || e)));
  });
}

const hosts = process.argv.slice(2).length
  ? [process.argv.slice(2)]
  : [
      ['vpn600012248.opengw.net', 1646],
      ['public-vpn-76.opengw.net', 443],
      ['vpn523361413.opengw.net', 1752],
    ];

// DoH 本身要走代理（本机直连 dns.google 不一定通），解析完再直连 IP
const proxy = parseProxy('http://127.0.0.1:7897');

for (const [host, port] of hosts) {
  const p = Number(port);
  console.log(`\n${host}:${p}`);
  let ips = [];
  try {
    ips = await resolveA(host, proxy);
    console.log(`  DoH → ${ips.length ? ips.join(', ') : '无 A 记录'}`);
  } catch (e) {
    console.log(`  DoH 解析失败 ${e?.message || e}`);
  }
  if (!ips.length) continue;
  for (const ip of ips.slice(0, 2)) {
    const r = await tcpProbe(ip, p);
    console.log(`  直连 ${ip}:${p} → ${r.ok ? 'OK' : 'FAIL'} ${r.ms}ms ${r.extra}`);
  }
}
