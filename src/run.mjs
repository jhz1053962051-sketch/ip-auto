/**
 * 主流水线：抓取 VPN Gate → 解析 SSTP → 并发探测 → 归属判定 → 生成订阅产物
 *
 * 用法：
 *   node src/run.mjs
 *   node src/run.mjs --countries JP,KR,SG --max 60 --concurrency 8
 *
 * 环境变量（全部可选）：
 *   IP_AUTO_PROXY       代理，默认 http://127.0.0.1:7897；置空字符串表示直连
 *   IP_AUTO_COUNTRIES   国家白名单，逗号分隔，默认 JP,KR,SG；置 all 表示不限
 *   IP_AUTO_MAX_NODES   最多检测多少个节点，默认 80
 *   IP_AUTO_CONCURRENCY 并发探测数，默认 6（本地 CPU/带宽友好）
 *   IP_AUTO_TIMEOUT_MS  单节点超时，默认 22000
 *   IP_AUTO_EDGE_HOSTS  自定义优选入口，逗号分隔，默认内置池
 *   IP_AUTO_PUBLIC_DIR  产物目录，默认 ./public
 *   IP_AUTO_DOH         DoH 端点，默认 https://dns.google/resolve
 *   IP_AUTO_PROXY_COUNTRIES  走公共代理池的国家，默认 SG（VPN Gate 没有的国家）
 *   IP_AUTO_PROXY_MAX        每国最多探测多少候选代理，默认 260
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProxy } from './http.mjs';
import { fetchVpngate, toSstpNodes, dedupeNodes } from './vpngate.mjs';
import { checkNode } from './probe.mjs';
import { collectProxyNodes } from './proxynodes.mjs';
import { lookupIps, normalizeExit } from './geo.mjs';
import { mapPool } from './pool.mjs';
import { buildNodesText, EDGE_HOSTS, COUNTRY_ZH, nodeLink, sortLatency } from './edges.mjs';
import { findAdminPassword, findEdgeBase, findUuid } from './secret.mjs';
import { renderIndexHtml } from './render.mjs';
import { subToken, subUrls, buildVlessNodes } from './sub.mjs';
import { rankByWorker, sortByWorker } from './workerrank.mjs';
import { measureReal, applyRealMs } from './realmeas.mjs';
import { probePurityBatch, applyPurity, purityStats } from './purity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const env = process.env;

const CONFIG = {
  proxyRaw: args.proxy !== undefined ? String(args.proxy) : (env.IP_AUTO_PROXY ?? 'http://127.0.0.1:7897'),
  countries: String(args.countries || env.IP_AUTO_COUNTRIES || 'JP,KR,SG'),
  maxNodes: Number(args.max || env.IP_AUTO_MAX_NODES || 80),
  concurrency: Number(args.concurrency || env.IP_AUTO_CONCURRENCY || 6),
  timeoutMs: Number(args.timeout || env.IP_AUTO_TIMEOUT_MS || 22000),
  publicDir: path.resolve(ROOT, args.out || env.IP_AUTO_PUBLIC_DIR || 'public'),
  edgeHosts: String(args.edges || env.IP_AUTO_EDGE_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  nodesUrl: env.IP_AUTO_NODES_URL || '',
  // 概览页地址（页面里「复制订阅」要完整 URL，客户端不认相对路径）
  site: String(args.site || env.IP_AUTO_SITE || 'https://jhz1053962051-sketch.github.io/ip-auto').replace(/\/+$/, ''),
  subHost: args['sub-host'] || env.IP_AUTO_SUB_HOST || new URL(findEdgeBase()).hostname,
  subUuid: args.uuid || findUuid(),
  // VPN Gate 没有的国家（目前只有新加坡），走公共代理池支线
  proxyCountries: String(args['proxy-countries'] || env.IP_AUTO_PROXY_COUNTRIES || 'SG')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  // 「额外再去代理池捞一遍」的国家：这些国家 VPN Gate 也有，只是 SSTP 建链太慢（1.8~2.5s），
  // 代理池里的 socks5/http 只要一次握手（Worker 侧 400~1400ms）。两边的节点都留下，
  // 住宅节点仍然排在前面，但快的那几个能让用户自己挑。
  proxyExtra: String(args['proxy-extra'] || env.IP_AUTO_PROXY_EXTRA || 'JP,KR')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  proxyMax: Number(args['proxy-max'] || env.IP_AUTO_PROXY_MAX || 260),
  // 用线上 Worker 给节点打真实延迟分（worker 视角 = 用户实际路径）。
  // 没给管理员密码就跳过，退回本地 latency_ms 排序。
  // 注意：Worker 排名这一步默认**直连**，不套 7897 —— 实测 pages.dev 经代理会
  // `schannel/socket disconnected before secure TLS` 直接失败，反而直连稳定（2.6s/200）。
  rankProxyRaw: args['rank-proxy'] !== undefined
    ? String(args['rank-proxy'])
    : (env.IP_AUTO_RANK_PROXY ?? ''),
  edgeAdmin: String(args['edge-admin'] || findAdminPassword() || ''),
  edgeBase: String(args['edge-base'] || findEdgeBase()),
  workerRank: Number(args['worker-rank'] || env.IP_AUTO_WORKER_RANK || 1),
  // 实测「客户端全链路 TTFB」：唯一覆盖「浏览器→CF colo→Worker→节点」的数字，
  // 也是页面/订阅的主排序键。本地跑得动（55 节点约 3 分钟），CI 在美区且没装 Xray，
  // 默认关闭（IP_AUTO_REAL_MEASURE=0），由本机计划任务负责刷新。
  realMeasure: Number(args['real-measure'] || env.IP_AUTO_REAL_MEASURE || 1),
  realLimit: Number(args['real-limit'] || env.IP_AUTO_REAL_LIMIT || 0),
  realConcurrency: Number(args['real-concurrency'] || env.IP_AUTO_REAL_CONCURRENCY || 3),
  // 纯净度（Scamalytics 欺诈分）：免 key、并发 4 实测无 429。
  // 默认开着 —— 没有这一列，用户在页面上分不出「住宅」和「干净」，会优先选到最脏的那批。
  purityMeasure: Number(args['purity'] || env.IP_AUTO_PURITY || 1),
  purityConcurrency: Number(args['purity-concurrency'] || env.IP_AUTO_PURITY_CONCURRENCY || 4),
};

const proxy = CONFIG.proxyRaw ? parseProxy(CONFIG.proxyRaw) : null;
// Worker 排名单独一条链路：默认直连（见 CONFIG.rankProxyRaw 注释）
const rankProxy = CONFIG.rankProxyRaw ? parseProxy(CONFIG.rankProxyRaw) : null;
const countryFilter = /^all$/i.test(CONFIG.countries)
  ? []
  : CONFIG.countries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
// VPN Gate 只负责它能覆盖的国家；新加坡这类它完全没有的，交给公共代理池支线。
// 两边不能有交集，否则 SG 会白跑一趟抓取（VPN Gate 返回 0 条 SSTP）。
const proxyOnlyFilter = countryFilter.length
  ? CONFIG.proxyCountries.filter((c) => countryFilter.includes(c))
  : CONFIG.proxyCountries;
// 额外支线：日韩在 VPN Gate 里有，但 SSTP 建链要 1.8~2.5s；代理池的 http/socks5 只要一次握手。
// 两条线都跑，节点都留着 —— 住宅优先排序不变，快的机房节点排在后面给用户挑。
const proxyExtraFilter = countryFilter.length
  ? CONFIG.proxyExtra.filter((c) => countryFilter.includes(c) && !proxyOnlyFilter.includes(c))
  : CONFIG.proxyExtra.filter((c) => !proxyOnlyFilter.includes(c));
const proxyCountryFilter = [...proxyOnlyFilter, ...proxyExtraFilter];
const vpnCountryFilter = countryFilter.filter((c) => !proxyOnlyFilter.includes(c));
const edgeHosts = CONFIG.edgeHosts.length ? CONFIG.edgeHosts : EDGE_HOSTS;

const t0 = Date.now();
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function main() {
  log('===== ip-auto 节点流水线启动 =====');
  log(`代理: ${proxy ? `${proxy.host}:${proxy.port}` : '直连(不推荐)'} | 国家: ${countryFilter.join(',') || '全部'} | 上限: ${CONFIG.maxNodes} | 并发: ${CONFIG.concurrency}`);
  if (proxyCountryFilter.length) log(`代理池支线: ${proxyCountryFilter.join(',')}（其中 ${proxyExtraFilter.join(',') || '无'} 与 VPN Gate 并行取快节点）`);

  // 1) 抓取（VPN Gate 支线；如果本次国家全由代理池负责，就跳过抓取）
  let rows = [];
  let source = 'none';
  if (vpnCountryFilter.length || !proxyCountryFilter.length) {
    const r = await fetchVpngate({ proxy, log: (m) => log('[source]', m) });
    rows = r.rows;
    source = r.source;
    log(`原始节点 ${rows.length} 条（来源 ${source}）`);
  } else {
    log('本次国家全部由公共代理池负责，跳过 VPN Gate 抓取');
  }

  // 2) 解析 SSTP
  const { nodes, stats } = toSstpNodes(rows, { countries: vpnCountryFilter });
  log(`SSTP(TCP) 节点 ${nodes.length} 条；跳过 非TCP ${stats.notTcp} / 国家过滤 ${stats.filtered} / 无配置 ${stats.noConfig}`);

  // 3) 去重 + 排序 + 截断
  // 排序规则：先用 hostname 启发式把「疑似家宽」(vpnNNNNNNNN) 排到前面，
  // 再按官方 score 降序 —— 家宽节点才是本项目的目标产物，机房节点只是兜底。
  const uniq = dedupeNodes(nodes)
    .sort((a, b) => {
      const ha = /^vpn\d{5,}/i.test(a.host) ? 0 : 1;
      const hb = /^vpn\d{5,}/i.test(b.host) ? 0 : 1;
      if (ha !== hb) return ha - hb;
      return (b.score || 0) - (a.score || 0);
    })
    .slice(0, CONFIG.maxNodes);
  log(`去重后待检测 ${uniq.length} 条（家宽候选 ${uniq.filter((n) => /^vpn\d{5,}/i.test(n.host)).length} 条）`);

  // 4) 并发探测
  const probeStart = Date.now();
  let okCount = 0;
  const results = await mapPool(
    uniq,
    CONFIG.concurrency,
    (n) => checkNode(n, { proxy, timeoutMs: CONFIG.timeoutMs }),
    (done, total, r) => {
      if (r?.ok) okCount++;
      const tag = r?.ok ? `OK  ${r.exitIp} ${r.responseTime}ms` : `FAIL ${r?.error || 'unknown'}`;
      log(`[${String(done).padStart(3)}/${total}] ${r?.host || '?'} ${tag}`);
    },
  );
  const probeMs = Date.now() - probeStart;

  const succeeded = results.filter((r) => r && r.ok);
  log(`SSTP 探测完成：成功 ${succeeded.length} / ${results.length}，耗时 ${(probeMs / 1000).toFixed(1)}s`);

  // 5) 出口 IP 归属
  const exitIps = succeeded.map((r) => r.exitIp).filter(Boolean);
  const geoMap = await lookupIps(exitIps, { proxy, timeoutMs: 20000 });
  for (const r of succeeded) {
    r.exit = normalizeExit(r.exitIp, geoMap.get(r.exitIp), r.host);
  }

  const resiCount = succeeded.filter((r) => r.exit.residential === 'residential').length;
  log(`SSTP 出口归属：住宅 ${resiCount} / 机房 ${succeeded.filter((r) => r.exit.residential === 'datacenter').length} / 未知 ${succeeded.filter((r) => r.exit.residential === 'unknown').length}`);

  // 5.5) 公共代理池支线（新加坡这类 VPN Gate 没有的国家）
  let proxyNodes = [];
  let proxyStats = null;
  if (proxyCountryFilter.length) {
    const pr = await collectProxyNodes(proxyCountryFilter, {
      proxy,
      concurrency: 24,
      timeoutMs: 12000,
      maxPerCountry: CONFIG.proxyMax,
      log,
    });
    proxyNodes = pr.nodes;
    proxyStats = pr.stats;
    results.push(...pr.failed.map((f) => ({ ...f, ok: false })));
    log(`公共代理池：候选 ${pr.stats.candidates} / 探测 ${pr.stats.checked} / 存活 ${pr.stats.alive} / 出口匹配 ${pr.stats.matched} → 采用 ${proxyNodes.length}`);
  }

  if (!succeeded.length && !proxyNodes.length) {
    throw new Error('全部节点探测失败（检查代理、网络或数据源可用性）');
  }

  // 6) 生成数据
  const generatedAt = new Date();
  const available = [
    ...succeeded.map((r) => ({
      host: r.host,
      port: r.port,
      protocol: 'sstp',
      link: nodeLink({ host: r.host, port: r.port, protocol: 'sstp' }),
      country: r.exit.country || null,
      country_code: r.exit.country_code || null,
      city: r.exit.city || null,
      org: r.exit.org || null,
      asn: r.exit.asn || null,
      isp: r.exit.isp || null,
      exit_ip: r.exitIp,
      assigned_ip: r.assignedIp,
      residential: r.exit.residential,
      latency_ms: r.responseTime,
      checked_at: generatedAt.toISOString(),
    })),
    ...proxyNodes.map((n) => ({ ...n, link: nodeLink(n) })),
  ].sort((a, b) => (a.latency_ms || 1e9) - (b.latency_ms || 1e9));

  // 5.9) 用线上 Worker 复测一遍，拿到用户实际路径（本机→CF colo→Worker→节点）的延迟。
  //      本地 probe 的 latency_ms 是「本机→代理→节点」，排序跟用户体感几乎不相关，
  //      所以拿 worker_ms 当主排序键；这一步失败不影响交付，只是退回 latency_ms。
  let workerStats = null;
  if (CONFIG.workerRank && CONFIG.edgeAdmin && available.length) {
    try {
      workerStats = await rankByWorker(available, {
        base: CONFIG.edgeBase,
        password: CONFIG.edgeAdmin,
        proxy: rankProxy,
        concurrency: Math.min(6, Math.max(3, CONFIG.concurrency)),
        timeoutMs: Math.max(CONFIG.timeoutMs, 35000),
        log,
        onProgress: (done, total, r, n) => {
          if (done === total || done % 10 === 0) {
            log(`[rank] ${done}/${total} 最后一个 ${n?.host || ''} → ${r.ok ? r.worker_ms + 'ms' : r.error}`);
          }
        },
      });
      // 只保留 Worker 测通的节点：Worker 都连不上的节点，客户端拿到也是死链。
      const alive = available.filter((n) => Number.isFinite(n.worker_ms));
      if (alive.length >= Math.max(3, Math.floor(available.length * 0.3))) {
        const dropped = available.length - alive.length;
        available.length = 0;
        available.push(...sortByWorker(alive));
        if (dropped) log(`[rank] 丢弃 ${dropped} 个 Worker 侧不可用节点`);
      } else {
        log(`[rank] Worker 只测通 ${alive.length}/${available.length}，结果不可信，保留全部节点`);
        sortByWorker(available);
      }
    } catch (e) {
      log(`[rank] Worker 复测失败（${e?.message || e}），退回本地延迟排序`);
      workerStats = null;
    }
  }

  const countries = {};
  for (const n of available) {
    const code = n.country_code || '??';
    countries[code] ??= { code, name: n.country || code, name_zh: COUNTRY_ZH[code] || n.country || code, nodes: [] };
    countries[code].nodes.push(n);
  }
  for (const g of Object.values(countries)) {
    g.count = g.nodes.length;
    g.residential = g.nodes.filter((n) => n.residential === 'residential').length;
    g.datacenter = g.nodes.filter((n) => n.residential === 'datacenter').length;
    // 组内也按 Worker 实测排，页面和订阅的顺序一致
    g.nodes.sort(sortLatency);
    const wl = g.nodes.map((n) => n.worker_ms).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    g.worker_ms_median = wl.length ? wl[Math.floor((wl.length - 1) / 2)] : null;
    g.worker_ms_min = wl.length ? wl[0] : null;
  }

  const data = {
    generated_at: generatedAt.toISOString(),
    generated_at_local: generatedAt.toString(),
    source,
    generator: 'ip-auto/1.0 (local)',
    config: {
      countries: countryFilter.length ? countryFilter : 'all',
      max_nodes: CONFIG.maxNodes,
      concurrency: CONFIG.concurrency,
      probe_ms: probeMs,
      total_ms: Date.now() - t0,
    },
    stats: {
      raw_rows: rows.length,
      sstp_nodes: nodes.length,
      checked: results.length,
      success: available.length,
      failed: results.length - available.length,
      residential: available.filter((n) => n.residential === 'residential').length,
      datacenter: available.filter((n) => n.residential === 'datacenter').length,
      countries: Object.keys(countries).length,
      proxy_candidates: proxyStats?.candidates ?? 0,
      proxy_alive: proxyStats?.alive ?? 0,
      proxy_matched: proxyStats?.matched ?? 0,
      worker_ranked: workerStats?.ok ?? 0,
      worker_rank_failed: workerStats?.failed ?? 0,
      worker_ms_median: workerStats?.p50 ?? null,
      worker_ms_min: workerStats?.min ?? null,
    },
    countries,
    available,
    failed: results
      .filter((r) => !r || !r.ok)
      .map((r) => ({ host: r?.host, port: r?.port, error: r?.error || 'unknown' })),
  };

  // 7) 落盘
  ensureDir(CONFIG.publicDir);
  const nodesText = buildNodesText(data, edgeHosts);
  // 订阅地址 + 每条节点的 vless 链接：算法与 Worker 一致，本地先算好，页面秒开
  const token = CONFIG.subHost ? subToken(CONFIG.subHost, CONFIG.subUuid) : '';
  const subs = token ? subUrls(CONFIG.subHost, token) : null;
  data.subscription = subs ? { host: CONFIG.subHost, uuid: CONFIG.subUuid, token, ...subs } : null;
  data.vless_nodes = subs ? buildVlessNodes(data, { host: CONFIG.subHost, uuid: CONFIG.subUuid, edgeHosts }) : [];

  // 直连支线（scripts/make-direct-sub.mjs）的上一轮产物挂进页面。
  // 它是唯一「比绕 Worker 快 600ms 以上」的一批节点，不挂进来等于白算。
  // 顺序上 CI 是先跑本文件、再跑 make-direct-sub，所以那一轮会由它自己重渲染覆盖；
  // 这里读旧文件只是保证「单跑 run.mjs」时页面不会丢掉直连面板。
  try {
    const directFile = path.join(ROOT, 'logs', 'direct-sub.json');
    if (fs.existsSync(directFile)) {
      const d = JSON.parse(fs.readFileSync(directFile, 'utf8'));
      if (Array.isArray(d.nodes) && d.nodes.length) {
        data.direct = {
          generated_at: d.generated_at,
          site: CONFIG.site,
          max_ms: d.max_ms,
          total: d.nodes.length,
          nodes: d.nodes,
        };
        log(`直连面板：挂载上一轮 ${d.nodes.length} 个直连节点`);
      }
    }
  } catch (e) {
    log(`直连面板挂载失败（忽略）：${e?.message || e}`);
  }
  fs.writeFileSync(path.join(CONFIG.publicDir, 'data.json'), JSON.stringify(data, null, 1), 'utf8');
  fs.writeFileSync(path.join(CONFIG.publicDir, 'nodes.txt'), nodesText, 'utf8');
  fs.writeFileSync(path.join(CONFIG.publicDir, 'index.html'), renderIndexHtml(data), 'utf8');
  fs.writeFileSync(path.join(CONFIG.publicDir, 'subscription.txt'), buildSimpleSubscription(available), 'utf8');

  // 7.5) 实测客户端真实延迟（全链路 TTFB），然后**重排 + 重渲染**。
  //      必须在 data.json / vless_nodes 都算好之后跑：它是按 vless_nodes[i].real 定位节点的。
  //      这是唯一覆盖「浏览器→CF colo→Worker→节点」的数字，也是页面和订阅的主排序键。
  if (CONFIG.realMeasure && available.length) {
    try {
      const xrayBin = path.join(ROOT, 'tools', process.platform === 'win32' ? 'xray.exe' : 'xray');
      if (!fs.existsSync(xrayBin)) {
        log('[real] 没有 tools/xray.exe，跳过实测（只在本机跑，CI 不需要）');
      } else {
        const targets = (CONFIG.realLimit > 0 ? data.vless_nodes.slice(0, CONFIG.realLimit) : data.vless_nodes)
          .map((v) => ({ ...v }));
        log(`[real] 开始实测 ${targets.length} 个节点的全链路 TTFB（每节点独立进程，并发 ${CONFIG.realConcurrency}）`);
        const real = await measureReal(targets, {
          root: ROOT,
          bin: xrayBin,
          basePort: Number(env.IP_AUTO_REAL_PORT || 14000),
          concurrency: CONFIG.realConcurrency,
          timeoutMs: Number(env.IP_AUTO_REAL_TIMEOUT || 20),
          log,
          onProgress: (done, total, it) => {
            if (done === total || done % 10 === 0) log(`[real] ${done}/${total} 最后 ${it.name} → ${it.real_ms ?? 'FAIL'}`);
          },
        });
        const hit = applyRealMs(available, real.flat);
        data.stats.real_ms_measured = real.matched;
        data.stats.real_ms_median = real.median;
        data.stats.real_ms_min = real.min;
        log(`[real] 实测完成：命中 ${hit}/${available.length}，可测 ${real.matched}/${real.total}，中位 ${real.median}ms，最快 ${real.min}ms`);

        // 有 real_ms 的节点按它排；没测到的留在原相对位置（applyRealMs 只写命中的）
        available.sort(sortLatency);
        for (const g of Object.values(countries)) g.nodes.sort(sortLatency);
        if (Array.isArray(data.vless_nodes)) {
          const byReal = new Map(real.flat.filter((x) => Number.isFinite(x.real_ms)).map((x) => [x.real, x.real_ms]));
          for (const v of data.vless_nodes) {
            const ms = byReal.get(v.real);
            if (Number.isFinite(ms)) v.real_ms = ms;
          }
          data.vless_nodes.sort((a, b) => {
            const f = (x) => (Number.isFinite(x.real_ms) ? x.real_ms : 1e9);
            return f(a) - f(b);
          });
        }

        // 重算 nodesText / vless_nodes / index.html，让顺序真的生效
        const nodesText2 = buildNodesText(data, edgeHosts);
        data.vless_nodes = buildVlessNodes(data, { host: CONFIG.subHost, uuid: CONFIG.subUuid, edgeHosts });
        // buildVlessNodes 会丢 real_ms（它是从 countries[].nodes 重建的），回填一次
        const byReal2 = new Map(real.flat.filter((x) => Number.isFinite(x.real_ms)).map((x) => [x.real, x.real_ms]));
        for (const v of data.vless_nodes) {
          const ms = byReal2.get(v.real);
          if (Number.isFinite(ms)) v.real_ms = ms;
        }
        fs.writeFileSync(path.join(CONFIG.publicDir, 'nodes.txt'), nodesText2, 'utf8');
        fs.writeFileSync(path.join(CONFIG.publicDir, 'data.json'), JSON.stringify(data, null, 1), 'utf8');
        fs.writeFileSync(path.join(CONFIG.publicDir, 'index.html'), renderIndexHtml(data), 'utf8');
        const realLogDir = path.join(ROOT, 'logs');
        ensureDir(realLogDir);
        fs.writeFileSync(path.join(realLogDir, 'real-lat.json'), JSON.stringify(real.flat, null, 1), 'utf8');
        log('[real] 已按实测延迟重排 nodes.txt / 订阅 / 页面');
      }
    } catch (e) {
      log(`[real] 实测失败（${e?.message || e}），仅用 Worker 侧延迟排序`);
    }
  }


  // 7.7) 纯净度（Scamalytics 欺诈分）。
  //      为什么要这一步：项目原来只用 ip-api 的 hosting 字段分「住宅/机房」并默认住宅更好，
  //      但实测 60 个出口 IP 后发现这个假设站不住 —— 住宅组的中位欺诈分反而更高
  //      （SoftEther 那批共享出口 17~86），阿里云/微软机房大量 0 分。
  //      「住宅」只说明归属，「干净」才决定会不会一开就弹验证码。
  //      放在 7.5 之后：那时 n.real_ip 才是真实出口（走 CF 的节点，host 是边缘 IP 104.26.x.x）。
  if (CONFIG.purityMeasure && available.length) {
    try {
      const ips = available
        .map((n) => n.real_ip || n.exit_ip || (/^\d+\.\d+\.\d+\.\d+$/.test(String(n.host || '')) ? n.host : ''))
        .filter(Boolean);
      const uniq = [...new Set(ips)];
      log(`[purity] 开始查询 ${uniq.length} 个出口 IP 的欺诈分（并发 ${CONFIG.purityConcurrency}）`);
      const table = await probePurityBatch(uniq, {
        proxy,
        concurrency: CONFIG.purityConcurrency,
        log,
      });
      const hit = applyPurity(available, table);
      // countries 里的节点和 available 是同一批对象引用，applyPurity 已就地改好；
      // 但 vless_nodes 是拷贝出来的，要单独回填，否则页面表格看不到 fraud。
      if (Array.isArray(data.vless_nodes)) {
        for (const v of data.vless_nodes) {
          const src = available.find((n) => `${n.host}:${n.port}` === v.real || n.name === v.name);
          const ip = src ? src.real_ip || src.exit_ip : '';
          const r = ip ? table.get(ip) : null;
          if (r && r.ok && Number.isFinite(r.fraud)) {
            v.fraud = r.fraud;
            v.fraud_risk = r.risk || null;
          }
        }
      }
      Object.assign(data.stats, purityStats(available));
      log(
        `[purity] 命中 ${hit}/${available.length}，中位 ${data.stats.fraud_median ?? '—'} 分，` +
          `干净 ${data.stats.fraud_clean} / 脏 ${data.stats.fraud_dirty}（含 ${data.stats.fraud_bad} 个 ≥75）`
      );
      fs.writeFileSync(path.join(CONFIG.publicDir, 'data.json'), JSON.stringify(data, null, 1), 'utf8');
      fs.writeFileSync(path.join(CONFIG.publicDir, 'index.html'), renderIndexHtml(data), 'utf8');
      ensureDir(path.join(ROOT, 'logs'));
      fs.writeFileSync(
        path.join(ROOT, 'logs', 'purity.json'),
        JSON.stringify({ at: generatedAt.toISOString(), table: Object.fromEntries(table) }, null, 1),
        'utf8'
      );
      log('[purity] 已写回 data.json / index.html 与 logs/purity.json');
    } catch (e) {
      log(`[purity] 查询失败（${e?.message || e}），跳过纯净度列`);
    }
  }


  // 8) 运行快照（便于看历史）
  const logsDir = path.join(ROOT, 'logs');
  ensureDir(logsDir);
  const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(logsDir, `run-${stamp}.json`), JSON.stringify(data, null, 1), 'utf8');
  fs.writeFileSync(path.join(logsDir, 'latest.json'), JSON.stringify({
    at: data.generated_at,
    stats: data.stats,
    probe_ms: probeMs,
    total_ms: Date.now() - t0,
    countries: countryFilter,
    proxy: proxy ? `${proxy.host}:${proxy.port}` : null,
    failed: data.failed.slice(0, 20),
  }, null, 1), 'utf8');

  log('===== 完成 =====');
  log(`产物目录 ${CONFIG.publicDir}`);
  log(`  data.json        ${data.stats.success} 个可用节点`);
  log(`  nodes.txt        ${nodesText.split('\n').filter(Boolean).length} 行订阅（edgetunnel 自定义优选 IP 用这个）`);
  log(`  index.html       本地站点 index.html（概览页）`);
  log(`  subscription.txt 纯 sstp:// 列表`);
  if (CONFIG.nodesUrl) log(`  订阅地址 ${CONFIG.nodesUrl}`);
  return data;
}

/** 纯 sstp:// 列表（给只认协议链接的客户端/调试用） */
function buildSimpleSubscription(available) {
  return available
    .map((n) => `#${n.country_code || '??'}-${n.residential === 'residential' ? '住宅' : '机房'}-${n.exit_ip || ''}\n${nodeLink(n)}`)
    .join('\n') + '\n';
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[${ts()}] 流水线失败: ${e?.stack || e}`);
    process.exit(1);
  });
