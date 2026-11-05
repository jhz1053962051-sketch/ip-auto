/**
 * 单节点探针：SSTP 隧道 → 隧道内 HTTP 请求 → 取出口 IP
 */
import { pathToFileURL } from 'node:url';
import { sstpEstablish, createTcpOverPpp, httpOverSstp } from './sstp.mjs';
import { parseProxy, httpJson } from './http.mjs';

// cloudflare-dns.com / one.one.one.one 在部分网络下对 application/dns-json 返回 400，
// dns.google 的 JSON 接口（Answer[].data）稳定可用，作为默认解析入口。
const DOH = process.env.IP_AUTO_DOH || 'https://dns.google/resolve';
const A_ONLY = /^\d+\.\d+\.\d+\.\d+$/;

const DOH_CACHE = new Map();
export async function resolveA(host, proxy) {
  if (A_ONLY.test(host)) return host;
  if (DOH_CACHE.has(host)) return DOH_CACHE.get(host);
  const data = await httpJson(`${DOH}?name=${encodeURIComponent(host)}&type=A`, {
    proxy,
    headers: { accept: 'application/dns-json' },
    timeoutMs: 10000,
  });
  const a = (data.Answer || []).find((x) => x.type === 1);
  if (!a) throw new Error(`DoH 无法解析 ${host}`);
  DOH_CACHE.set(host, a.data);
  return a.data;
}

/**
 * @param {{host:string, port?:number, user?:string, pass?:string}} node
 * @param {{proxy?:object, probeHost?:string, probePath?:string, timeoutMs?:number}} opt
 */
export async function checkNode(node, opt = {}) {
  const {
    proxy = null,
    probeHost = 'api.ipify.org',
    probePath = '/?format=json',
    timeoutMs = 22000,
  } = opt;

  const t0 = Date.now();
  let sstp = null;
  try {
    // 先解析探针域名，避免隧道建立后长时间空闲被服务器断开
    const destIp = await resolveA(probeHost, proxy);
    sstp = await sstpEstablish({
      host: node.host,
      port: node.port || 443,
      proxy,
      user: node.user || 'vpn',
      pass: node.pass || 'vpn',
      timeoutMs,
    });
    const tcp = createTcpOverPpp(sstp, sstp.assignedIp, destIp);
    await tcp.handshake(80, timeoutMs);
    const res = await httpOverSstp({ sstp, tcp, targetHost: probeHost, path: probePath, timeoutMs });
    if (res.status < 200 || res.status >= 300) throw new Error(`探针 HTTP ${res.status}`);

    // 出口 IP 必须是合法的公网 IPv4 JSON。若隧道内被运营商/热点劫持到登录页，
    // 返回的是一段 HTML —— 这种节点不能算可用。
    const text = res.body.trim();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const head = text.replace(/\s+/g, ' ').slice(0, 40);
      throw new Error(`探针返回非 JSON（疑似劫持页）: ${head}`);
    }
    const exitIp = typeof parsed?.ip === 'string' ? parsed.ip : null;
    if (!exitIp || !A_ONLY.test(exitIp)) throw new Error(`探针 IP 非法: ${JSON.stringify(parsed).slice(0, 60)}`);
    if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(exitIp)) {
      throw new Error(`探针拿到内网/保留地址: ${exitIp}`);
    }

    return {
      ok: true,
      host: node.host,
      port: node.port || 443,
      assignedIp: sstp.assignedIp,
      exitIp,
      responseTime: Date.now() - t0,
    };
  } catch (error) {
    return {
      ok: false,
      host: node.host,
      port: node.port || 443,
      error: error?.message || String(error),
      responseTime: Date.now() - t0,
    };
  } finally {
    try { sstp?.close(); } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.argv[2] || '219.100.37.103';
  const port = Number(process.argv[3] || 443);
  const proxy = parseProxy(process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897');
  console.log(JSON.stringify(await checkNode({ host, port }, { proxy }), null, 2));
}
