/**
 * 线上 /sub 验收：钉住香港 colo IP（域名直连会随机被掐），UA 用真实客户端。
 *
 * ⚠️ 实测纠正：edgetunnel 的 /sub 返回的是 **base64 编码的订阅**（v2rayN 标准格式），
 * 不是明文。以前交接备忘里写过「明文」是错的 —— 判断办法：body 开头是 `dmxlc3M6Ly8`
 * 就是 base64("vless://")。这里两种都认，先试解码。
 */
import { httpRequest } from '../src/http.mjs';

const BASE = process.env.IP_AUTO_EDGE_BASE || 'https://ipauto-edge.pages.dev';
const TOKEN = process.env.IP_AUTO_SUB_TOKEN || '2ce8fa81f3da82450905b322ab649142';
const EDGE = process.env.IP_AUTO_EDGE_IP || '104.26.1.10';

const url = `${BASE}/sub?token=${TOKEN}`;
const t0 = Date.now();
const r = await httpRequest(url, {
  connectIp: EDGE,
  timeoutMs: 25000,
  headers: { 'User-Agent': 'v2rayN/6.31' },
});
const ms = Date.now() - t0;

function maybeDecode(body) {
  const raw = body.trim();
  if (raw.startsWith('vless://')) return { text: raw, encoded: false };
  try {
    const dec = Buffer.from(raw, 'base64').toString('utf8');
    if (dec.includes('vless://')) return { text: dec, encoded: true };
  } catch {
    /* 不是 base64 就算了 */
  }
  return { text: raw, encoded: false };
}

const { text, encoded } = maybeDecode(r.body);
console.log(`HTTP ${r.status}  ${r.body.length}B  ${ms}ms  (edge ${EDGE})`);
console.log(`格式：${encoded ? 'base64（v2rayN 标准）' : '明文'}`);

const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('vless://'));
console.log(`vless 节点 ${lines.length} 条`);

const names = lines.map((l) => {
  const frag = l.split('#')[1] || '';
  try {
    return decodeURIComponent(frag);
  } catch {
    return frag;
  }
});
const tally = {};
for (const n of names) {
  const cc = n.split('-')[0];
  tally[cc] = (tally[cc] || 0) + 1;
}
console.log('分布', JSON.stringify(tally));
console.log('前 5 条：');
for (const n of names.slice(0, 5)) console.log('  ', n);

// 订阅里带的入口 IP 种类（钉住 colo 后应该都是 EDGE_IPS 里的）
const entries = [...new Set(lines.map((l) => (l.match(/@([\d.]+):(\d+)/) || []).slice(1).join(':')))];
console.log(`唯一入口 ${entries.length} 个，例如 ${entries.slice(0, 4).join(' / ')}`);

process.exit(r.status === 200 && lines.length ? 0 : 1);