/**
 * 决定性测试：本机能不能**直连** VPN Gate 节点（不经 7897、不经 Cloudflare）。
 *
 * 为什么这件事重要：
 *   现在整条链是「客户端 → CF colo → Worker → SSTP 节点」。每一跳都串行，且 SSTP 要
 *   TLS + PPP(LCP/PAP/IPCP) 协商，所以住宅节点有个 ~2.5s 的地板，换节点换不掉。
 *   如果本机能直连节点本身，那就可以直接跑 OpenVPN / SSTP 客户端：
 *     - 少两跳（CF colo + Worker）
 *     - UDP 模式没有 TCP-over-TCP，握手一次到位
 *   延迟会从 2.5s 掉到 100~300ms（正常 VPN 水平），而且是同一批住宅 IP。
 *
 * 测三件事：
 *   1. TCP 直连 SSTP 端口（443 或随机端口）—— 能否 SYN 成功
 *   2. TCP 直连 OpenVPN 端口（配置里 remote 的端口）
 *   3. UDP 打 OpenVPN 端口，看有没有 P_CONTROL 回包（OpenVPN 服务端会回 hard-reset / ack）
 *
 * 用法：node test/direct-node.mjs [host] [sstpPort] [ovpnPort]
 */
import net from 'node:net';
import dgram from 'node:dgram';

const HOST = process.argv[2] || 'vpn600012248.opengw.net';
const SSTP_PORT = Number(process.argv[3] || 1646);
const OVPN_PORT = Number(process.argv[4] || SSTP_PORT);

const t0 = () => Date.now();

function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = t0();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok, extra = '') => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, ms: t0() - started, extra });
    };
    sock.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    sock.once('connect', () => finish(true, 'SYN-ACK'));
    sock.once('error', (e) => finish(false, e.code || String(e.message || e)));
  });
}

function udpProbe(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = t0();
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (ok, extra = '') => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      resolve({ ok, ms: t0() - started, extra });
    };
    sock.on('message', (buf) => finish(true, `${buf.length}B ${buf.slice(0, 8).toString('hex')}`));
    sock.on('error', (e) => finish(false, e.code || String(e.message || e)));
    sock.send(Buffer.from([0x38, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), port, host, (e) => {
      if (e) finish(false, e.code || String(e.message || e));
    });
    setTimeout(() => finish(false, 'timeout/no-reply'), timeoutMs);
  });
}

console.log(`目标 ${HOST}`);
const sstp = await tcpProbe(HOST, SSTP_PORT);
console.log(`  TCP :${SSTP_PORT} (SSTP)  → ${sstp.ok ? 'OK' : 'FAIL'} ${sstp.ms}ms ${sstp.extra}`);
const ovpn = await tcpProbe(HOST, OVPN_PORT);
console.log(`  TCP :${OVPN_PORT} (OpenVPN/TCP) → ${ovpn.ok ? 'OK' : 'FAIL'} ${ovpn.ms}ms ${ovpn.extra}`);
const u = await udpProbe(HOST, OVPN_PORT);
console.log(`  UDP :${OVPN_PORT} (OpenVPN/UDP) → ${u.ok ? 'OK' : 'FAIL'} ${u.ms}ms ${u.extra}`);
