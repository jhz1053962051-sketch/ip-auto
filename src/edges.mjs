/**
 * 优选入口池（域名 + 固定 anycast IP）+ 国家中文名 + nodes.txt 组装。
 *
 * ## 入口地址到底在干什么（别搞反）
 * edgetunnel 生成的 vless 节点长这样：
 *   vless://UUID@<入口>:443?...&sni=<Worker 自己的域名>&host=<Worker 自己的域名>
 * 也就是说 **SNI 和 Host 都被改写成 Worker 域名**，`<入口>` 只提供一个
 * 「能解析到 Cloudflare anycast 的 IP」。因此判断入口好不好的标准不是
 * 「这个域名能不能打开」，而是「它的 IP 能不能承载我们的 SNI」。
 *
 * ## 本池是实测出来的，不是照抄
 * 上游 gate 项目（https://github.com/hezhanleiok/gate，无 LICENSE）给的是 20 个
 * 泛域名池，实测其中 6 个在本机/大陆环境下承载不了我们的 SNI，已剔除：
 *   - www.bilibili.com        非 Cloudflare IP（221.15.71.66），证书不匹配
 *   - securecircle.com        非 CF IP（173.223.234.199），TLS 直接 alert
 *   - saas.sin.fan / openai.com / uspto.gov / linear.app   TLS/HTTP 全部超时
 * 复测命令：`node test/edge-entry-check.mjs`（SNI 固定 ipauto-edge.pages.dev）
 * 复测命令：`node test/edge-ip-probe.mjs`（固定 IP × 我们的 SNI）
 *
 * 排序原则：固定 IP 在前（省一次 DNS、抖动更小），域名按实测延迟升序。
 */
export const EDGE_IPS = [
  '104.26.10.209',
  '162.159.140.98',
  '172.67.74.209',
  '172.64.152.5',
  '172.64.156.171',
  '104.21.0.1',
  '172.66.0.96',
  '172.66.44.226',
];

export const EDGE_DOMAINS = [
  'p.etime.vip',
  'www.sloomb.com',
  'www.shopify.com',
  'cf.nyanya.moe',
  'spring.io',
  'cdn.ctn32.us.kg',
  'www.vmware.com',
  'cdn.204910.best',
  'cf.877774.xyz',
  'www.leics.police.uk',
  'www.carousell.sg',
  'op.chinwa.eu.cc',
  'www.dbs.com.sg',
  'www.mfyx.cn',
];

/** 完整入口池（IP 优先） */
export const EDGE_HOSTS = [...EDGE_IPS, ...EDGE_DOMAINS].map((h) => `${h}:443`);

export const COUNTRY_ZH = {
  JP: '日本',
  KR: '韩国',
  TH: '泰国',
  TW: '台湾',
  HK: '香港',
  SG: '新加坡',
  US: '美国',
  VN: '越南',
  RU: '俄罗斯',
  FR: '法国',
  DE: '德国',
  GB: '英国',
  CA: '加拿大',
  AU: '澳大利亚',
  IN: '印度',
  ID: '印度尼西亚',
  MY: '马来西亚',
  PH: '菲律宾',
  BR: '巴西',
  AR: '阿根廷',
  TR: '土耳其',
  UA: '乌克兰',
  PL: '波兰',
  NL: '荷兰',
  IT: '意大利',
  ES: '西班牙',
  SE: '瑞典',
  NO: '挪威',
  FI: '芬兰',
  DK: '丹麦',
  CH: '瑞士',
  AT: '奥地利',
  CZ: '捷克',
  RO: '罗马尼亚',
  MX: '墨西哥',
  CL: '智利',
  ZA: '南非',
  EG: '埃及',
  IR: '伊朗',
  KZ: '哈萨克斯坦',
  CN: '中国',
};

/**
 * 生成 nodes.txt：每行 `入口域名:端口#国家-住宅-01$sstp://vpn:vpn@host:port`
 *
 * 这个格式是 edgetunnel「自定义优选IP」能直接吃的：
 *   `$sstp://...` 是链式代理后缀，前半段是 Cloudflare 优选入口。
 * 住宅节点排在机房节点之前，方便客户端优先挑纯净住宅 IP。
 */
/**
 * 一条节点对应的「真实代理」链接，直接喂给 edgetunnel 的链式代理。
 *
 * 为什么需要按协议区分：VPN Gate 只能给 SSTP（`sstp://vpn:vpn@host:port`），
 * 而新加坡这类 VPN Gate 根本没有的国家，只能从公共代理池里捞 socks5 / http，
 * 它们的写法完全不同，认证信息也常常为空。edgetunnel 侧
 * `_worker.js:427` 的正则是 `\$(socks5|http|https|turn|sstp)://...`，
 * 所以 `$` 后面直接跟协议名即可，用户名密码有则带上、无则省略。
 */
export function nodeLink(n) {
  const proto = String(n?.protocol || n?.proto || 'sstp').toLowerCase();
  const host = n?.host;
  const port = n?.port;
  if (!host || !port) return '';
  if (proto === 'sstp') return `sstp://vpn:vpn@${host}:${port}`;
  const auth = n.user && n.pass ? `${encodeURIComponent(n.user)}:${encodeURIComponent(n.pass)}@` : '';
  return `${proto}://${auth}${host}:${port}`;
}

/** 节点的协议短标签，用于页面按钮文案 */
export function protoLabel(n) {
  const proto = String(n?.protocol || n?.proto || 'sstp').toLowerCase();
  return { sstp: 'SSTP', socks5: 'SOCKS5', http: 'HTTP', https: 'HTTPS', turn: 'TURN' }[proto] || proto.toUpperCase();
}

export function buildNodesText(data, edgeHosts = EDGE_HOSTS) {
  const edge = (edgeHosts && edgeHosts.length ? edgeHosts : EDGE_HOSTS).filter(Boolean);
  const groups = Object.values(data.countries || {});
  // 节点多的国家排前面
  groups.sort((a, b) => (b.count || 0) - (a.count || 0));

  const lines = [];
  let idx = 0;
  for (const g of groups) {
    const code = String(g.code || '??').toUpperCase();
    const zh = COUNTRY_ZH[code] || g.name || code;
    const nodes = (g.nodes || []).slice().sort((a, b) => {
      const ra = a.residential === 'residential' ? 0 : 1;
      const rb = b.residential === 'residential' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (a.latency_ms || 1e9) - (b.latency_ms || 1e9);
    });
    const resi = nodes.filter((n) => n.residential === 'residential');
    const dc = nodes.filter((n) => n.residential !== 'residential');

    let i = 0;
    for (const n of resi) {
      i++;
      const entry = edge[idx++ % edge.length];
      lines.push(`${entry}#${zh}-住宅-${String(i).padStart(2, '0')}$${nodeLink(n)}`);
    }
    i = 0;
    for (const n of dc) {
      i++;
      const entry = edge[idx++ % edge.length];
      lines.push(`${entry}#${zh}-机房-${String(i).padStart(2, '0')}$${nodeLink(n)}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
