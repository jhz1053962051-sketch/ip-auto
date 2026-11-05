/**
 * 从订阅里挑一个节点生成 Xray 测试配置，并可指定「入口 IP / 入口域名」。
 * 与 make-xray-direct.mjs 的区别：支持按索引（含国家关键字）挑节点，便于验证日/韩不同出口。
 *
 * 用法:
 *   node scripts/make-xray-node.mjs --port 10849 --index 0
 *   node scripts/make-xray-node.mjs --port 10849 --country 韩国
 *   node scripts/make-xray-node.mjs --port 10849 --country 日本 --entry 172.64.152.5
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const PORT = Number(arg('port', 10839));
const SUB = path.join(ROOT, arg('sub', 'logs/sub-pages-decoded.txt'));
if (!fs.existsSync(SUB)) throw new Error(`缺少 ${SUB}：先抓 /sub 并 base64 解码`);

const lines = fs.readFileSync(SUB, 'utf8').split(/\r?\n/).filter(Boolean);
const parse = (line) => {
  const m = line.match(/^vless:\/\/([^@]+)@([^:]+):(\d+)\?([^#]*)/);
  if (!m) throw new Error('无法解析: ' + line.slice(0, 80));
  const q = new URLSearchParams(m[4]);
  return {
    id: m[1], addr: m[2], port: Number(m[3]),
    sni: q.get('sni'), host: q.get('host'), path: q.get('path'),
    tag: decodeURIComponent(line.split('#')[1] || ''),
  };
};

let idx = arg('index') !== null ? Number(arg('index')) : null;
if (idx === null) {
  const kw = arg('country', null);
  idx = kw ? lines.findIndex((l) => decodeURIComponent(l.split('#')[1] || '').includes(kw)) : 0;
  if (idx < 0) throw new Error(`订阅里没有含「${kw}」的节点`);
}
const node = parse(lines[idx]);
const entry = arg('entry', null) || node.addr;
const entryPort = Number(arg('entry-port', node.port || 443));

const config = {
  log: { loglevel: 'warning' },
  inbounds: [{ tag: 'socks-in', port: PORT, listen: '127.0.0.1', protocol: 'socks', settings: { auth: 'noauth', udp: true } }],
  outbounds: [
    {
      tag: 'proxy',
      protocol: 'vless',
      settings: { vnext: [{ address: entry, port: entryPort, users: [{ id: node.id, encryption: 'none', flow: '' }] }] },
      streamSettings: {
        network: 'ws',
        security: 'tls',
        tlsSettings: { serverName: node.sni, allowInsecure: false, fingerprint: 'chrome', alpn: ['http/1.1'] },
        wsSettings: { path: node.path, headers: { Host: node.host } },
      },
    },
    { tag: 'direct', protocol: 'freedom' },
  ],
};

const out = path.join(ROOT, `logs/xray-node-${PORT}.json`);
fs.writeFileSync(out, JSON.stringify(config, null, 2));
console.log(`[${idx}] ${node.tag}  入口 ${entry}:${entryPort}  SNI ${node.sni}  Host ${node.host}`);
console.log(`配置 ${out}  socks 127.0.0.1:${PORT}`);
