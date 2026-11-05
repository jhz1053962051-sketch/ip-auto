/**
 * 优选入口域名池 + 国家中文名 + nodes.txt 组装。
 *
 * 入口地址的作用：edgetunnel 生成的节点会以「入口域名」作为 TLS/SNI 门面连接 Cloudflare，
 * 再由 Cloudflare 回源到 Worker。这里沿用上游 gate 项目的 20 个公开优选域名池
 * （https://github.com/hezhanleiok/gate 的 EDGE_HOSTS，无 LICENSE，仅按公开列表原样沿用；
 *  如不希望依赖第三方域名，用 IP_AUTO_EDGE_HOSTS 换成自己的域名）。
 */

export const EDGE_HOSTS = [
  'saas.sin.fan:443',
  'cdn.204910.best:443',
  'www.mfyx.cn:443',
  'p.etime.vip:443',
  'cdn.ctn32.us.kg:443',
  'cf.877774.xyz:443',
  'spring.io:443',
  'cf.nyanya.moe:443',
  'www.sloomb.com:443',
  'op.chinwa.eu.cc:443',
  'www.leics.police.uk:443',
  'securecircle.com:443',
  'www.shopify.com:443',
  'www.carousell.sg:443',
  'www.dbs.com.sg:443',
  'openai.com:443',
  'linear.app:443',
  'www.bilibili.com:443',
  'uspto.gov:443',
  'www.vmware.com:443',
];

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
      lines.push(`${entry}#${zh}-住宅-${String(i).padStart(2, '0')}$sstp://vpn:vpn@${n.host}:${n.port}`);
    }
    i = 0;
    for (const n of dc) {
      i++;
      const entry = edge[idx++ % edge.length];
      lines.push(`${entry}#${zh}-机房-${String(i).padStart(2, '0')}$sstp://vpn:vpn@${n.host}:${n.port}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
