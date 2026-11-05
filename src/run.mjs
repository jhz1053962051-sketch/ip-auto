/**
 * 主流水线：抓取 VPN Gate → 解析 SSTP → 并发探测 → 归属判定 → 生成订阅产物
 *
 * 用法：
 *   node src/run.mjs
 *   node src/run.mjs --countries JP,KR --max 60 --concurrency 8
 *
 * 环境变量（全部可选）：
 *   IP_AUTO_PROXY       代理，默认 http://127.0.0.1:7897；置空字符串表示直连
 *   IP_AUTO_COUNTRIES   国家白名单，逗号分隔，默认 JP,KR；置 all 表示不限
 *   IP_AUTO_MAX_NODES   最多检测多少个节点，默认 80
 *   IP_AUTO_CONCURRENCY 并发探测数，默认 6（本地 CPU/带宽友好）
 *   IP_AUTO_TIMEOUT_MS  单节点超时，默认 22000
 *   IP_AUTO_EDGE_HOSTS  自定义优选入口，逗号分隔，默认内置池
 *   IP_AUTO_PUBLIC_DIR  产物目录，默认 ./public
 *   IP_AUTO_DOH         DoH 端点，默认 https://dns.google/resolve
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProxy } from './http.mjs';
import { fetchVpngate, toSstpNodes, dedupeNodes } from './vpngate.mjs';
import { checkNode } from './probe.mjs';
import { lookupIps, normalizeExit } from './geo.mjs';
import { mapPool } from './pool.mjs';
import { buildNodesText, EDGE_HOSTS, COUNTRY_ZH } from './edges.mjs';
import { renderIndexHtml } from './render.mjs';

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
  countries: String(args.countries || env.IP_AUTO_COUNTRIES || 'JP,KR'),
  maxNodes: Number(args.max || env.IP_AUTO_MAX_NODES || 80),
  concurrency: Number(args.concurrency || env.IP_AUTO_CONCURRENCY || 6),
  timeoutMs: Number(args.timeout || env.IP_AUTO_TIMEOUT_MS || 22000),
  publicDir: path.resolve(ROOT, args.out || env.IP_AUTO_PUBLIC_DIR || 'public'),
  edgeHosts: String(args.edges || env.IP_AUTO_EDGE_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  nodesUrl: env.IP_AUTO_NODES_URL || '',
};

const proxy = CONFIG.proxyRaw ? parseProxy(CONFIG.proxyRaw) : null;
const countryFilter = /^all$/i.test(CONFIG.countries)
  ? []
  : CONFIG.countries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
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

  // 1) 抓取
  const { rows, source } = await fetchVpngate({ proxy, log: (m) => log('[source]', m) });
  log(`原始节点 ${rows.length} 条（来源 ${source}）`);

  // 2) 解析 SSTP
  const { nodes, stats } = toSstpNodes(rows, { countries: countryFilter });
  log(`SSTP(TCP) 节点 ${nodes.length} 条；跳过 非TCP ${stats.notTcp} / 国家过滤 ${stats.filtered} / 无配置 ${stats.noConfig}`);
  if (!nodes.length) throw new Error('没有解析出任何 SSTP 节点');

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
  log(`探测完成：成功 ${succeeded.length} / ${results.length}，耗时 ${(probeMs / 1000).toFixed(1)}s`);
  if (!succeeded.length) throw new Error('全部节点探测失败（检查代理、网络或 VPN Gate 可用性）');

  // 5) 出口 IP 归属
  const exitIps = succeeded.map((r) => r.exitIp).filter(Boolean);
  const geoMap = await lookupIps(exitIps, { proxy, timeoutMs: 20000 });
  for (const r of succeeded) {
    r.exit = normalizeExit(r.exitIp, geoMap.get(r.exitIp), r.host);
  }

  const resiCount = succeeded.filter((r) => r.exit.residential === 'residential').length;
  log(`出口归属：住宅 ${resiCount} / 机房 ${succeeded.filter((r) => r.exit.residential === 'datacenter').length} / 未知 ${succeeded.filter((r) => r.exit.residential === 'unknown').length}`);

  // 6) 生成数据
  const generatedAt = new Date();
  const available = succeeded
    .map((r) => ({
      host: r.host,
      port: r.port,
      protocol: 'sstp',
      link: `sstp://vpn:vpn@${r.host}:${r.port}`,
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
    }))
    .sort((a, b) => (a.latency_ms || 1e9) - (b.latency_ms || 1e9));

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
  fs.writeFileSync(path.join(CONFIG.publicDir, 'data.json'), JSON.stringify(data, null, 1), 'utf8');
  fs.writeFileSync(path.join(CONFIG.publicDir, 'nodes.txt'), nodesText, 'utf8');
  fs.writeFileSync(path.join(CONFIG.publicDir, 'index.html'), renderIndexHtml(data), 'utf8');
  fs.writeFileSync(path.join(CONFIG.publicDir, 'subscription.txt'), buildSimpleSubscription(available), 'utf8');

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
    .map((n) => `#${n.country_code || '??'}-${n.residential === 'residential' ? '住宅' : '机房'}-${n.exit_ip || ''}\nsstp://vpn:vpn@${n.host}:${n.port}`)
    .join('\n') + '\n';
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[${ts()}] 流水线失败: ${e?.stack || e}`);
    process.exit(1);
  });
