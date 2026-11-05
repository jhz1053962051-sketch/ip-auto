/**
 * 从订阅里取一个节点，生成一份 Xray 客户端配置，用来做真实端到端验证。
 * 用法: node scripts/make-xray-test.mjs [节点序号=0] [本地端口=10809]
 */
import fs from 'node:fs';
import path from 'node:path';

const idx = Number(process.argv[2] || 0);
const port = Number(process.argv[3] || 10809);
const ROOT = path.resolve(import.meta.dirname, '..');

let text = fs.readFileSync(path.join(ROOT, 'logs/sub.txt'), 'utf8').trim();
if (!text.startsWith('vless://')) text = Buffer.from(text, 'base64').toString('utf8');
const lines = text.split(/\r?\n/).filter((l) => l.startsWith('vless://'));
if (!lines.length) throw new Error('订阅里没有 vless 节点');
const link = lines[idx];
const u = new URL(link);

const cfg = {
  log: { loglevel: 'warning' },
  inbounds: [{
    tag: 'socks-in', port, listen: '127.0.0.1', protocol: 'socks',
    settings: { auth: 'noauth', udp: true },
  }],
  outbounds: [{
    tag: 'proxy', protocol: 'vless',
    settings: {
      vnext: [{
        address: u.hostname,
        port: Number(u.port || 443),
        users: [{ id: u.username, encryption: u.searchParams.get('encryption') || 'none', flow: u.searchParams.get('flow') || '' }],
      }],
    },
    streamSettings: {
      network: 'ws',
      security: u.searchParams.get('security') || 'tls',
      tlsSettings: {
        serverName: u.searchParams.get('sni') || u.hostname,
        allowInsecure: false,
        fingerprint: u.searchParams.get('fp') || 'chrome',
        alpn: (u.searchParams.get('alpn') || 'http/1.1').split(','),
      },
      wsSettings: {
        path: u.searchParams.get('path') || '/',
        headers: { Host: u.searchParams.get('host') || u.hostname },
      },
    },
  }],
};

const out = path.join(ROOT, 'logs/xray-test.json');
fs.writeFileSync(out, JSON.stringify(cfg, null, 2));
console.log(`节点 #${idx}: ${decodeURIComponent(u.hash.slice(1))}`);
console.log(`入口: ${u.hostname}:${u.port}  SNI=${cfg.outbounds[0].streamSettings.tlsSettings.serverName}`);
console.log(`配置: ${out}   本地 socks5: 127.0.0.1:${port}`);
