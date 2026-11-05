/**
 * 优选入口池（固定 anycast IP + 域名）+ 国家中文名 + nodes.txt 组装。
 *
 * ## 入口地址到底在干什么（别搞反）
 * edgetunnel 生成的 vless 节点长这样：
 *   vless://UUID@<入口>:443?...&sni=<Worker 自己的域名>&host=<Worker 自己的域名>
 * 也就是说 **SNI 和 Host 都被改写成 Worker 域名**，`<入口>` 只提供一个
 * 「能解析到 Cloudflare anycast 的 IP」。因此判断入口好不好的标准不是
 * 「这个域名能不能打开」，而是「它的 IP 能不能承载我们的 SNI」。
 *
 * ## 为什么要按 colo 排序（延迟优化）
 * 入口 IP 决定请求落到哪个 Cloudflare 机房（colo），而 **Worker 就跑在那个 colo 上**——
 * 所以入口选的是「Worker 部署在哪」，不只是「本机连得快不快」。Worker 落在 HKG 时，
 * 它到日韩住宅 SSTP 节点是一次短跳；落在 LAX 就要跨太平洋两个来回。
 *
 * 实测（2026-11-05，直连、无代理、SNI 固定 Worker 域名）：
 *   同一节点、只换入口的端到端耗时：
 *     HKG 组：104.26.1.10 2273ms / 104.26.0.10 2311ms / 104.26.0.1 2425ms
 *             104.26.10.209 2449ms / 104.26.1.1 2462ms / 104.26.1.20 2591ms
 *             104.26.0.20 2720ms / 104.26.10.20 2768ms / 104.26.10.1 2816ms / 104.26.10.10 2828ms
 *             —— 10/10 全部 2/2 成功
 *     LAX 组：spring.io 6977ms（1/2 成功）/ 104.17.0.1 15321ms（1/2）
 *             104.18.0.1 16696ms（1/2）/ 104.27.0.1 3286ms（2/2）
 *             —— 一半超时（>15s）
 *   注意 104.27.0.1 虽然 TLS 只要 179ms（本机直连最快），落到 LAX，端到端反而 3.3s 且抖动。
 *   **所以判据是 colo，不是本机 TLS 耗时。**
 *
 * 复测命令：
 *   `node test/colo-hunt.mjs`        扫 144 个 IP 找 HKG colo
 *   `node test/colo-direct.mjs`      扫候选入口各自的 colo
 *   `node test/entry-ab.mjs`         同一节点只换入口的端到端 A/B（一次只起一个 inbound）
 *   `node test/direct-edge-scan.mjs` 直连下的 DNS/TCP/TLS/TTFB 分段耗时
 *
 * 排序原则：HKG 组按实测 A/B 耗时升序在最前；域名只作备份（本机实测没有一个域名落 HKG），
 * 放在后面兜底——万一 104.26.0.0/24 哪天被封，还有能解析到 CF anycast 的入口可用。
 */
export const EDGE_IPS = [
  // —— HKG 组（端到端 A/B 实测 2.27~2.83s，10/10 全部成功；按耗时升序）
  '104.26.1.10',
  '104.26.0.10',
  '104.26.0.1',
  '104.26.10.209',
  '104.26.1.1',
  '104.26.1.20',
  '104.26.0.20',
  '104.26.10.20',
  '104.26.10.1',
  '104.26.10.10',
];

export const EDGE_DOMAINS = [
  // —— 备份组：全部实测落 LAX，端到端比 HKG 慢 0.5~1.5 倍，只在 IP 组整体不可用时才轮到
  'cdn.ctn32.us.kg',
  'www.mfyx.cn',
  'cdn.204910.best',
  'www.sloomb.com',
  'op.chinwa.eu.cc',
  'www.dbs.com.sg',
];

/**
 * 被剔除的入口，以及原因（别再加回来，除非重测通过）：
 *   cf.877774.xyz        LAX  tls=11061ms  灾难级
 *   cf.nyanya.moe        LAX  tls=3877ms
 *   p.etime.vip          LAX  tls=2511ms
 *   www.shopify.com      LAX  tls=3365ms，且直连 TLS 超时
 *   www.carousell.sg     LAX  tls=532ms 但 ttfb=3679ms（首包极慢）
 *   www.leics.police.uk  LAX  tls=539ms 但直连 TLS 超时
 *   172.64.152.5 / 172.64.156.171 / 104.21.0.1 / 172.66.0.96
 *   spring.io / www.vmware.com / 104.27.0.1 / 104.17.0.1 / 104.18.0.1
 *                                                 全部落 LAX，端到端 1.5~16s 且半数超时
 *   172.64.0.1 / 172.67.0.1 / 104.28.0.1 / 172.65.0.1   TCP 超时或 ECONNRESET
 *   www.bilibili.com     非 CF IP，证书不匹配
 *   securecircle.com     非 CF IP，TLS alert
 */

export const EDGE_HOSTS = [...EDGE_IPS, ...EDGE_DOMAINS].map(h => h + ':443');

export const COUNTRY_ZH = {
  JP: '日本', KR: '韩国', SG: '新加坡', TH: '泰国', TW: '台湾', HK: '香港',
  US: '美国', GB: '英国', UK: '英国', DE: '德国', FR: '法国', NL: '荷兰',
  RU: '俄罗斯', VN: '越南', MY: '马来西亚', ID: '印尼', PH: '菲律宾',
  IN: '印度', AU: '澳大利亚', CA: '加拿大', BR: '巴西', AR: '阿根廷',
  TR: '土耳其', AE: '阿联酋', IL: '以色列', IT: '意大利', ES: '西班牙',
  SE: '瑞典', NO: '挪威', FI: '芬兰', DK: '丹麦', PL: '波兰', CZ: '捷克',
  CH: '瑞士', AT: '奥地利', BE: '比利时', IE: '爱尔兰', PT: '葡萄牙',
  RO: '罗马尼亚', UA: '乌克兰', KZ: '哈萨克', ZA: '南非', MX: '墨西哥',
  CL: '智利', CO: '哥伦比亚', PE: '秘鲁', NZ: '新西兰', MO: '澳门',
  CN: '中国', PK: '巴基斯坦', BD: '孟加拉', LK: '斯里兰卡', NP: '尼泊尔',
};

/** 节点 → 链路链接（sstp 带 vpn/vpn 账号，其余按协议拼） */
export function nodeLink(n) {
  const proto = String(n.protocol || n.proto || 'sstp').toLowerCase();
  if (proto === 'sstp') return `sstp://vpn:vpn@${n.host}:${n.port}`;
  const auth = n.user && n.pass ? `${n.user}:${n.pass}@` : '';
  return `${proto}://${auth}${n.host}:${n.port}`;
}

/** 协议 → 展示文案 */
export function protoLabel(n) {
  const proto = String(n.protocol || n.proto || 'sstp').toLowerCase();
  return { sstp: 'SSTP', socks5: 'SOCKS5', http: 'HTTP', https: 'HTTPS', turn: 'TURN' }[proto] || proto.toUpperCase();
}

/** 是否是住宅出口 */
export function isResi(n) {
  return n.residential === 'residential' || n.residential === true;
}

/**
 * 排序用的延迟：优先 Worker 实测（worker_ms），没有才退回本地建链耗时（latency_ms）。
 *
 * 为什么不直接比 latency_ms：latency_ms 是「本机 → 代理 → SSTP 节点」的建链总耗时，
 * 而用户实际走「本机 → CF colo → Worker → SSTP 节点」。实测两者排序几乎不相关：
 * 本地最快的 SG 节点 294ms，Worker 视角 16680ms；Worker 最快的日本节点 1619ms，
 * 本地只是中位。用 latency_ms 排序 = 按错的尺子排队。
 */
export function sortLatency(a, b) {
  const av = Number.isFinite(a.worker_ms) ? a.worker_ms : Infinity;
  const bv = Number.isFinite(b.worker_ms) ? b.worker_ms : Infinity;
  if (av !== bv) return av - bv;
  return (a.latency_ms || 1e9) - (b.latency_ms || 1e9);
}

/**
 * nodes.txt 组装。
 * 每行：`入口:443#国家-住宅/机房-NN$链路`
 *
 * 排序：**全部按真实延迟升序**（worker_ms 优先），住宅/机房混合排。
 * 编号仍按「住宅 01..N / 机房 01..N」各自独立，只是行的先后由延迟决定 ——
 * 因为实测最快的节点往往是 76~500ms 的机房 socks5，而住宅 SSTP 因握手成本在 1.8s 起，
 * 若住宅整体前置，订阅前几十条全是慢节点，客户端首次测速就选到最差的。
 * 入口按 EDGE_HOSTS 顺序轮转——因为 EDGE_HOSTS 已经按 colo + TLS 耗时排好，
 * 轮转等于把「最快入口」均匀摊到每个节点上，客户端做并发测速时第一梯队
 * 就都是好入口。
 *
 * 注意：`data.countries` 是**对象**（按国家代码索引），不是数组。
 */
export function buildNodesText(data, edgeHosts = EDGE_HOSTS) {
  const edge = (edgeHosts && edgeHosts.length ? edgeHosts : EDGE_HOSTS).filter(Boolean);
  const groups = Object.values(data.countries || {});
  groups.sort((a, b) => (b.count || 0) - (a.count || 0));

  // 先给每个节点起好名字（国家-住宅/机房-NN，按国家内各自的延迟升序编号），
  // 再把**全部节点混在一起按真实延迟排序** —— 用户第一个测速的就是全场最快的那个。
  // 早先是「按国家分组、国家按节点数排、住宅整体前置」，结果第一行永远是 1.7s 的
  // 韩国住宅 SSTP，而 76ms 的新加坡机房排在第 50 多位，实际体验就是「全都慢」。
  const labeled = [];
  for (const g of groups) {
    const code = String(g.code || '??').toUpperCase();
    const zh = COUNTRY_ZH[code] || g.name || code;
    const nodes = (g.nodes || []).slice().sort(sortLatency);
    for (const [list, kind] of [[nodes.filter(isResi), '住宅'], [nodes.filter((n) => !isResi(n)), '机房']]) {
      list.forEach((n, i) => labeled.push({ n, label: `${zh}-${kind}-${String(i + 1).padStart(2, '0')}` }));
    }
  }
  labeled.sort((a, b) => sortLatency(a.n, b.n));

  const lines = [];
  let idx = 0;
  for (const it of labeled) {
    const entry = edge[idx++ % edge.length];
    lines.push(`${entry}#${it.label}$${nodeLink(it.n)}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
