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
import { COUNTRY_ZH, EDGE_HOSTS, nodeLink, sortLatency } from './edges.mjs';

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

  // 与 edges.mjs 的 buildNodesText 严格同序：
  // 编号仍按「国家内住宅/机房各自从 01 起」，但**输出顺序是全局按真实延迟排**，
  // 这样 nodes.txt 第 N 行与订阅第 N 条指向同一个节点、同一个入口。
  const labeled = [];
  for (const g of groups) {
    const code = String(g.code || '??').toUpperCase();
    const zh = COUNTRY_ZH[code] || g.name || code;
    const sorted = (g.nodes || []).slice().sort(sortLatency);
    for (const [list, kind] of [[sorted.filter((n) => n.residential === 'residential'), '住宅'], [sorted.filter((n) => n.residential !== 'residential'), '机房']]) {
      list.forEach((n, i) => labeled.push({ n, code, kind, name: `${zh}-${kind}-${String(i + 1).padStart(2, '0')}` }));
    }
  }
  labeled.sort((a, b) => sortLatency(a.n, b.n));

  const nodes = [];
  let idx = 0;
  for (const { n, code, kind, name } of labeled) {
    {
      const entry = edge[idx++ % edge.length];
      // 链式代理的 payload：协议不同，字段也不同。
      // sstp 用固定的 vpn/vpn（VPN Gate 的约定）；socks5/http 有认证才带用户名密码，
      // 否则只给 hostname/port —— edgetunnel 的 `获取SOCKS5账号` 两种都认。
      const proto = String(n.protocol || n.proto || 'sstp').toLowerCase();
      const payloadObj = { type: proto };
      if (proto === 'sstp') {
        payloadObj.username = 'vpn';
        payloadObj.password = 'vpn';
      } else if (n.user && n.pass) {
        payloadObj.username = n.user;
        payloadObj.password = n.pass;
      }
      payloadObj.hostname = n.host;
      payloadObj.port = n.port;
      const payload = JSON.stringify(payloadObj);
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
        cc: code,
        country_code: code,
        entry,
        real: `${n.host}:${n.port}`,
        exit_ip: n.exit_ip || '',
        org: n.org || '',
        latency_ms: n.latency_ms,
        worker_ms: Number.isFinite(n.worker_ms) ? n.worker_ms : null,
        // real_ms 由 scripts/measure-real.mjs 事后用真 Xray 客户端测出并写回
        // countries[].nodes，这里透传给页面，让用户看到「自己这条链的真实体感」。
        real_ms: Number.isFinite(n.real_ms) ? n.real_ms : null,
        residential: n.residential === 'residential',
        vless: `vless://${uuid}@${entry.replace(':443', '')}:443?${qs}#${encodeURIComponent(name)}`,
        protocol: proto,
        sstp: nodeLink(n),
      });
    }
  }
  return nodes;
}
