/**
 * 订阅地址与 vless 链接的本地生成。
 *
 * 为什么要在本地算一遍：edgetunnel 的 `/sub?token=` 每次请求都要现算全部节点
 * （浏览器 UA 甚至要 40 秒），而且用户得先记住一长串 token。这里把同一套算法
 * 搬到流水线里，index.html 就能直接列出订阅地址和每一条 vless 链接，纯静态、
 * 秒开、不依赖 Worker。
 *
 * 算法都来自 `_src/cmliu_edgetunnel/_worker.js`：
 *   - token：`MD5MD5(host + uuid)` = `md5(md5(t).slice(7, 27))`（_worker.js:5403）
 *   - 节点名：`<国家>-<住宅|机房>-<两位序号>`，与 nodes.txt 里的 `#` 后段一致
 *   - 链路 payload：`base64SecretEncode(JSON, uuid)`，`_worker.js:4751`
 *     即逐字节 `data[i] ^ key[i % key.length]`，key 为 uuid 的 UTF-8 字节
 *
 * 生成结果已与线上 `/sub` 逐条比对，字符串完全一致（见 README「订阅地址」一节）。
 */
import crypto from 'node:crypto';
import { COUNTRY_ZH, EDGE_HOSTS } from './edges.mjs';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/** edgetunnel 的 token 算法：不是简单 md5，中间要切一段再 md5 */
export function subToken(host, uuid) {
  const once = md5(host + uuid);
  return md5(once.slice(7, 27));
}

/** 与 Worker 的 base64SecretEncode 等价：XOR 后再 base64 */
export function xorB64(plain, secret) {
  const data = Buffer.from(plain, 'utf8');
  const key = Buffer.from(secret, 'utf8');
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
  return out.toString('base64');
}

export function subUrls(host, token) {
  const base = `https://${host}/sub?token=${token}`;
  return { sub: base, clash: `${base}&clash`, base64: base };
}

/**
 * 按 nodes.txt 的同一套顺序生成节点（住宅优先、按延迟升序、入口轮转），
 * 每项多带一个可直接导入的 vless 链接。
 */
export function buildVlessNodes(data, { host, uuid, edgeHosts = EDGE_HOSTS }) {
  if (!host || !uuid) return [];
  const edge = (edgeHosts && edgeHosts.length ? edgeHosts : EDGE_HOSTS).filter(Boolean);
  const groups = Object.values(data.countries || {});
  groups.sort((a, b) => (b.count || 0) - (a.count || 0));

  const nodes = [];
  let idx = 0;
  for (const g of groups) {
    const code = String(g.code || '??').toUpperCase();
    const zh = COUNTRY_ZH[code] || g.name || code;
    const sorted = (g.nodes || []).slice().sort((a, b) => {
      const ra = a.residential === 'residential' ? 0 : 1;
      const rb = b.residential === 'residential' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (a.latency_ms || 1e9) - (b.latency_ms || 1e9);
    });
    const resi = sorted.filter((n) => n.residential === 'residential');
    const dc = sorted.filter((n) => n.residential !== 'residential');

    for (const [list, kind] of [[resi, '住宅'], [dc, '机房']]) {
      let i = 0;
      for (const n of list) {
        i++;
        const entry = edge[idx++ % edge.length];
        const name = `${zh}-${kind}-${String(i).padStart(2, '0')}`;
        const payload = JSON.stringify({
          type: 'sstp',
          username: 'vpn',
          password: 'vpn',
          hostname: n.host,
          port: n.port,
        });
        const path = `/video/${xorB64(payload, uuid)}`;
        const qs = [
          'security=tls',
          'type=ws',
          `host=${host}`,
          'fp=chrome',
          `sni=${host}`,
          `path=${encodeURIComponent(path)}`,
          'encryption=none',
          'alpn=',
        ].join('&');
        nodes.push({
          name,
          kind,
          entry,
          real: `${n.host}:${n.port}`,
          exit_ip: n.exit_ip || '',
          org: n.org || '',
          latency_ms: n.latency_ms,
          residential: n.residential === 'residential',
          vless: `vless://${uuid}@${entry.replace(':443', '')}:443?${qs}#${encodeURIComponent(name)}`,
          sstp: `sstp://vpn:vpn@${n.host}:${n.port}`,
        });
      }
    }
  }
  return nodes;
}
