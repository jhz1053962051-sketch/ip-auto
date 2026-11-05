/**
 * 生成「真直连」测试用的 Xray 配置：入口域名直接用 Pages/Worker 自己的域名，
 * 不经过任何优选 IP、也不挂 dialerProxy，用来验证「本机裸连 → 边缘 → 住宅出口」。
 *
 * 用法:
 *   node scripts/make-xray-direct.mjs <端口> [入口域名] [SNI]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] || 10839);
const ENTRY = process.argv[3] || 'ipauto-edge.pages.dev';
const SNI = process.argv[4] || ENTRY;

const SUB = path.join(ROOT, 'logs/sub-pages-decoded.txt');
if (!fs.existsSync(SUB)) throw new Error(`缺少 ${SUB}，先抓一次 /sub 并解码`);
const lines = fs.readFileSync(SUB, 'utf8').split(/\r?\n/).filter(Boolean);

function parse(line) {
  const m = line.match(/^vless:\/\/([^@]+)@([^:]+):(\d+)\?([^#]*)/);
  if (!m) throw new Error('无法解析节点: ' + line.slice(0, 80));
  const q = new URLSearchParams(m[4]);
  return {
    id: m[1],
    sni: q.get('sni'),
    host: q.get('host'),
    path: q.get('path'),
    tag: decodeURIComponent(line.split('#')[1] || ''),
  };
}

const node = parse(lines[0]);
const config = {
  log: { loglevel: 'warning' },
  inbounds: [
    { tag: 'socks-in', port: PORT, listen: '127.0.0.1', protocol: 'socks', settings: { auth: 'noauth', udp: true } },
  ],
  outbounds: [
    {
      tag: 'proxy',
      protocol: 'vless',
      settings: {
        vnext: [{ address: ENTRY, port: 443, users: [{ id: node.id, encryption: 'none', flow: '' }] }],
      },
      streamSettings: {
        network: 'ws',
        security: 'tls',
        tlsSettings: { serverName: SNI, allowInsecure: false, fingerprint: 'chrome', alpn: ['http/1.1'] },
        wsSettings: { path: node.path, headers: { Host: node.host } },
      },
    },
    { tag: 'direct', protocol: 'freedom' },
  ],
};

const out = path.join(ROOT, `logs/xray-direct-${PORT}.json`);
fs.writeFileSync(out, JSON.stringify(config, null, 2));
console.log(`入口 ${ENTRY}:443  SNI ${SNI}  Host ${node.host}  节点 ${node.tag}`);
console.log(`配置 ${out}  socks 127.0.0.1:${PORT}`);
