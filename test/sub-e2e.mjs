/**
 * 订阅端到端验证：把订阅里前 N 个节点各自映射到一个本地 socks 端口，
 * 起一个 Xray 进程同时跑，逐个探测真实出口 IP 与归属，统计成功率。
 *
 * 这一步验证的是「客户端拿订阅原样导入 → 直接出网」，
 * 所以配置里**不加** dialerProxy（不借用本机 7897 代理）。
 *
 * 用法:
 *   node test/sub-e2e.mjs [--sub logs/sub-pages-decoded.txt] [--count 8] [--base-port 10900]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const SUB = path.join(ROOT, arg('sub', 'logs/sub-pages-decoded.txt'));
const COUNT = Number(arg('count', 8));
const BASE = Number(arg('base-port', 10900));
const XRAY = path.join(ROOT, 'tools/xray.exe');

if (!fs.existsSync(SUB)) throw new Error(`缺少 ${SUB}`);
if (!fs.existsSync(XRAY)) throw new Error(`缺少 ${XRAY}`);

const lines = fs.readFileSync(SUB, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, COUNT);
const parse = (line) => {
  const m = line.match(/^vless:\/\/([^@]+)@([^:]+):(\d+)\?([^#]*)/);
  const q = new URLSearchParams(m[4]);
  return { id: m[1], addr: m[2], port: Number(m[3]), sni: q.get('sni'), host: q.get('host'), path: q.get('path'), tag: decodeURIComponent(line.split('#')[1] || '') };
};

const nodes = lines.map(parse);
const inbounds = [];
const outbounds = [];
const rules = [];
nodes.forEach((n, i) => {
  const port = BASE + i;
  inbounds.push({ tag: `s${i}`, port, listen: '127.0.0.1', protocol: 'socks', settings: { auth: 'noauth', udp: true } });
  outbounds.push({
    tag: `p${i}`,
    protocol: 'vless',
    settings: { vnext: [{ address: n.addr, port: n.port, users: [{ id: n.id, encryption: 'none', flow: '' }] }] },
    streamSettings: {
      network: 'ws', security: 'tls',
      tlsSettings: { serverName: n.sni, allowInsecure: false, fingerprint: 'chrome', alpn: ['http/1.1'] },
      wsSettings: { path: n.path, headers: { Host: n.host } },
    },
  });
  rules.push({ type: 'field', inboundTag: [`s${i}`], outboundTag: `p${i}` });
});
outbounds.push({ tag: 'direct', protocol: 'freedom' });

const cfgPath = path.join(ROOT, 'logs/xray-sub-e2e.json');
fs.writeFileSync(cfgPath, JSON.stringify({ log: { loglevel: 'warning' }, inbounds, outbounds, routing: { rules } }, null, 2));

const proc = spawn(XRAY, ['run', '-c', cfgPath], { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = null;
proc.on('exit', (c) => { exitCode = c; });
await sleep(7000);
if (exitCode !== null) throw new Error(`xray 退出，code=${exitCode}`);

async function probe(port) {
  const t0 = Date.now();
  try {
    // curl 走 socks5（http.mjs 只实现了 HTTP CONNECT 代理，不支持 socks）
    const out = execFileSync('curl', [
      '-sS', '--max-time', '45', '--socks5-hostname', `127.0.0.1:${port}`,
      'http://ip-api.com/json/?fields=status,country,regionName,city,isp,as,reverse,hosting,proxy,query',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(out);
    if (j.status !== 'success') return { ok: false, err: `ip-api: ${j.message || out.slice(0, 60)}` };
    return { ok: true, ms: Date.now() - t0, ip: j.query, country: j.country, city: j.city, isp: j.isp, as: j.as, reverse: j.reverse, hosting: j.hosting, proxy: j.proxy };
  } catch (e) {
    const msg = `${e.stderr || ''}${e.message || ''}`.replace(/\s+/g, ' ').trim();
    return { ok: false, err: msg.slice(-90) };
  }
}

const results = await Promise.all(nodes.map((n, i) => probe(BASE + i).then((r) => ({ node: n, ...r }))));
try { proc.kill(); } catch {}

let ok = 0;
for (const r of results) {
  if (r.ok) {
    ok++;
    console.log(`✅ ${r.node.tag.padEnd(14)} ${String(r.ms).padStart(5)}ms  ${r.ip.padEnd(16)} ${r.country}/${r.city}  ${r.isp.slice(0, 34)}${r.hosting ? ' [机房]' : ''}`);
  } else {
    console.log(`❌ ${r.node.tag.padEnd(14)} ${r.err}`);
  }
}
console.log(`\n直连成功率 ${ok}/${results.length}`);
const resi = results.filter((r) => r.ok && !r.hosting).length;
console.log(`其中住宅 ${resi} / 机房 ${ok - resi}`);
