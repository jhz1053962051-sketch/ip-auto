/**
 * 构建「直连节点池」——完全绕开 Cloudflare / Worker。
 *
 * ## 为什么这条线能把延迟砍掉 2/3
 * 现在的订阅走「客户端 → CF colo → Worker → 节点」，实测同一批节点：
 *
 *   节点                    直连       经 CF+Worker
 *   SG http 4.144.146.21:80   329ms  →  983ms
 *   JP http 8.209.255.13:3128 332ms  →  565ms
 *
 * 差的这 600~700ms 全是 Cloudflare 那一跳 + Worker 里建链的开销，跟节点本身无关。
 * http / socks5 代理客户端原生就支持，没有任何理由绕 Worker。
 *
 * ## 那住宅 SSTP 怎么办
 * 住宅节点必须经 SSTP 拨号，客户端（Xray）不认这个协议，只能靠 Worker 中转 ——
 * 这条线保留给「要住宅 IP」的场景。本脚本只负责「要快」的场景。
 *
 * ## 本机 DNS 的坑（重要）
 * `*.opengw.net` 在本机 DNS 解析不出来（ENOENT），必须 DoH。DoH 走 7897 出网，
 * 被探测的代理本身是**直连**的，所以测出来的延迟是用户真实会看到的。
 *
 * ## 产出（都要能直接当订阅用）
 *   public/direct/clash.yaml  Clash / mihomo 订阅（http+socks5 混合，按延迟排序）
 *   public/direct/xray.json   Xray 配置（N 个 socks inbound，端口 10800 起）
 *   public/direct/nodes.txt   人读清单
 *
 * 用法：node scripts/make-direct-sub.mjs [--countries JP,KR,SG] [--max 400] [--max-ms 3000]
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { httpRequest, parseProxy } from '../src/http.mjs';
import { checkProxy, parseProxyLine } from '../src/proxycheck.mjs';
import { fetchProxyCandidates } from '../src/proxysrc.mjs';
import { lookupIps } from '../src/geo.mjs';
import { mapPool } from '../src/pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const COUNTRIES = String(arg('countries', 'JP,KR,SG')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const MAX_PER_CC = Number(arg('max', '400'));
const MAX_MS = Number(arg('max-ms', '3000'));
const CONC = Number(arg('concurrency', '32'));
const TIMEOUT = Number(arg('timeout', '8000'));
const OUT = path.resolve(ROOT, arg('out', 'public/direct'));
const DOH = process.env.IP_AUTO_DOH || 'https://dns.google/resolve';

// DoH 自身要走一条能出网的链路：本机直连 dns.google 不通，默认借 7897；
// CI（GitHub Actions）是直连环境，用 IP_AUTO_DOH_PROXY='' 置空。
// 注意：被探测的代理一律直连，绝不走这个 proxy —— 否则测出来的不是用户路径。
const DOH_PROXY_RAW = arg('doh-proxy', process.env.IP_AUTO_DOH_PROXY ?? 'http://127.0.0.1:7897');
const dohProxy = DOH_PROXY_RAW ? parseProxy(DOH_PROXY_RAW) : null;

// 概览页地址（直连面板里「复制订阅」要给出完整 URL，客户端不认相对路径）
const SITE = String(arg('site', process.env.IP_AUTO_SITE || 'https://jhz1053962051-sketch.github.io/ip-auto')).replace(/\/+$/, '');

/* ---------------------------- 抓候选 ---------------------------- */
const alive = [];
for (const cc of COUNTRIES) {
  const { candidates, errors } = await fetchProxyCandidates(cc, { proxy: dohProxy, log: (m) => console.log(m) });
  if (errors.length) console.log(`[${cc}] 数据源告警：${errors[0]}`);
  if (!candidates.length) continue;

  // 保留源里声明的协议（proxifly 会标 socks5:// / https://），否则默认 http
  const targets = [];
  for (const line of candidates.slice(0, MAX_PER_CC)) {
    const p = parseProxyLine(line, 'http');
    if (!p?.host || !p?.port) continue;
    targets.push({ type: p.type, host: p.host, port: p.port, user: p.user, pass: p.pass, src: line });
  }
  console.log(`[${cc}] 候选 ${candidates.length} → 直连探测 ${targets.length} 个（并发 ${CONC}，超时 ${TIMEOUT}ms）`);

  let okCount = 0;
  const rs = await mapPool(targets, CONC, (t) => checkProxy(t, { timeoutMs: TIMEOUT }), (done, total, r) => {
    if (r?.ok) {
      okCount++;
      if (r.responseTime <= MAX_MS) console.log(`  ✓ ${r.type.padEnd(6)} ${r.host}:${String(r.port).padEnd(6)} ${String(r.responseTime).padStart(5)}ms ${r.loc || '??'}`);
    }
  });
  console.log(`[${cc}] 直连存活 ${okCount}/${targets.length}`);

  for (const r of rs) {
    if (!r?.ok) continue;
    if (r.responseTime > MAX_MS) continue;
    alive.push({ cc, proto: r.type, host: r.host, port: r.port, user: r.user || null, pass: r.pass || null, direct_ms: r.responseTime, exitIp: r.exitIp, loc: r.loc });
  }
}

/* ------------------- 出口归属校验（只留真在目标国） ------------------- */
console.log(`\n存活且 <${MAX_MS}ms：${alive.length} 个，反查出口归属…`);
const geoMap = await lookupIps(alive.map((n) => n.exitIp).filter(Boolean), { proxy: dohProxy, timeoutMs: 20000 });

const kept = [];
for (const n of alive) {
  const rec = geoMap.get(n.exitIp);
  const actual = String(rec?.countryCode || '').toUpperCase();
  if (actual && actual !== n.cc) continue; // 出口跑到别国的，剔除
  const asnM = String(rec?.as || '').match(/^(AS\d+)\s+(.*)$/i);
  kept.push({
    ...n,
    country: rec?.country || n.cc,
    country_code: n.cc,
    city: rec?.city || null,
    org: rec?.org || rec?.isp || null,
    asn: asnM ? asnM[1] : null,
    asn_name: asnM ? asnM[2] : null,
    residential: rec?.hosting === false ? 'residential' : 'datacenter',
  });
}

// 同出口 IP 只留最快的一个
const best = new Map();
for (const n of kept) {
  const k = n.exitIp || `${n.host}:${n.port}`;
  const prev = best.get(k);
  if (!prev || n.direct_ms < prev.direct_ms) best.set(k, n);
}
let final = [...best.values()].sort((a, b) => a.direct_ms - b.direct_ms);

console.log(`出口校验通过 ${kept.length}，去重后 ${final.length}`);
const byCc = {};
for (const n of final) (byCc[n.cc] ||= []).push(n);
for (const [cc, list] of Object.entries(byCc)) {
  const v = list.map((n) => n.direct_ms);
  console.log(`  ${cc}  n=${list.length}  min=${Math.min(...v)}ms  p50=${v.sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)]}ms  max=${Math.max(...v)}ms  住宅 ${list.filter((n) => n.residential === 'residential').length}`);
}

/* ---------------------------- 生成文件 ---------------------------- */
function clashYaml(list) {
  const L = [
    '# 直连节点（不经 Cloudflare / Worker）',
    '# 由 ip-auto/scripts/make-direct-sub.mjs 自动生成，每天随流水线刷新',
    '# 延迟列 = 本机直连该代理 CONNECT cloudflare.com:443 → /cdn-cgi/trace 的实测耗时',
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    '',
    'proxies:',
  ];
  for (const n of list) {
    const name = `${n.cc}-${n.residential === 'residential' ? '住宅' : '机房'}-${n.direct_ms}ms-${n.host}`;
    L.push(`  - name: "${name}"`);
    L.push(`    type: ${n.proto === 'socks5' ? 'socks5' : 'http'}`);
    L.push(`    server: ${n.host}`);
    L.push(`    port: ${n.port}`);
    if (n.user && n.pass) { L.push(`    username: "${n.user}"`); L.push(`    password: "${n.pass}"`); }
    if (n.proto === 'socks5') L.push('    udp: false');
    L.push('');
  }
  L.push('proxy-groups:');
  L.push('  - name: "最快"');
  L.push('    type: url-test');
  L.push('    url: "http://www.gstatic.com/generate_204"');
  L.push('    interval: 300');
  L.push('    tolerance: 60');
  L.push('    proxies:');
  for (const n of list) L.push(`      - "${n.cc}-${n.residential === 'residential' ? '住宅' : '机房'}-${n.direct_ms}ms-${n.host}"`);
  L.push('');
  for (const [cc, group] of Object.entries(byCc)) {
    L.push(`  - name: "${cc}"`);
    L.push('    type: url-test');
    L.push('    url: "http://www.gstatic.com/generate_204"');
    L.push('    interval: 300');
    L.push('    proxies:');
    for (const n of group) L.push(`      - "${n.cc}-${n.residential === 'residential' ? '住宅' : '机房'}-${n.direct_ms}ms-${n.host}"`);
    L.push('');
  }
  L.push('rules:');
  L.push('  - MATCH,最快');
  L.push('');
  return L.join('\n');
}

function xrayJson(list, basePort = 10800) {
  const inbounds = [];
  const outbounds = [{ tag: 'direct', protocol: 'freedom' }];
  const rules = [];
  list.forEach((n, i) => {
    const tag = `p${i}`;
    inbounds.push({ tag: `in-${i}`, listen: '127.0.0.1', port: basePort + i, protocol: 'socks', settings: { auth: 'noauth', udp: false } });
    const ob = { tag, protocol: n.proto === 'socks5' ? 'socks' : 'http', settings: { servers: [{ address: n.host, port: n.port }] } };
    if (n.user && n.pass) ob.settings.servers[0].users = [{ user: n.user, pass: n.pass }];
    outbounds.push(ob);
    rules.push({ type: 'field', inboundTag: [`in-${i}`], outboundTag: tag });
  });
  return { log: { loglevel: 'warning' }, inbounds, outbounds, routing: { domainStrategy: 'AsIs', rules } };
}

function nodesText(list) {
  const L = [
    '# 直连节点清单（不经 Cloudflare / Worker）',
    '# 序号 | 地区 | 类型 | 机房/住宅 | 地址 | 直连延迟 | 出口 IP | 组织',
    '#',
    '# Clash / mihomo：把 https://jhz1053962051-sketch.github.io/ip-auto/direct/clash.yaml 作为订阅地址导入',
    '# Xray：tools/xray.exe run -c public/direct/xray.json，socks 端口 10800 起（顺序与下表一致）',
    '',
  ];
  list.forEach((n, i) => {
    L.push(`${String(i + 1).padStart(2)}. ${n.cc} | ${n.proto} | ${n.residential === 'residential' ? '住宅' : '机房'} | ${n.host}:${n.port} | ${n.direct_ms}ms | ${n.exitIp} | ${n.org || '-'}`);
  });
  return `${L.join('\n')}\n`;
}

fs.mkdirSync(OUT, { recursive: true });

// 一轮抓到 0 个是可能的（公共池全天波动）。此时**不覆盖**上一轮的好文件 ——
// 空订阅会让客户端把已有节点全清掉，比"今天的节点旧一点"糟糕得多。
if (!final.length) {
  console.log('\n本轮直连可用 0 个，保留上一轮产物不覆盖');
  process.exit(0);
}

// 只剩一两个也别急着把上一轮的整批覆盖掉：公共池常常是「这一轮 SG 源挂了」，
// 不代表上一轮那些节点都死了。少于 3 个且上一轮更多时，合并保留（新的优先、按地址去重）。
const prevJson = path.join(OUT, 'nodes.json');
// 注意：merged 必须是**新数组**（final.slice()），不能写成 `let merged = final` 再清空 final ——
// 那样 merged 会跟着变空（踩过一次：产物写出 0 个）。
let merged = final.slice();
if (final.length < 3 && fs.existsSync(prevJson)) {
  try {
    const prev = JSON.parse(fs.readFileSync(prevJson, 'utf8'));
    const list = Array.isArray(prev?.nodes) ? prev.nodes : [];
    if (list.length > final.length) {
      const seen = new Set(final.map((n) => `${n.host}:${n.port}`));
      const extra = list.filter((n) => n?.host && !seen.has(`${n.host}:${n.port}`));
      merged = [...final, ...extra].sort((a, b) => (a.direct_ms || 1e9) - (b.direct_ms || 1e9));
      console.log(`\n本轮只抓到 ${final.length} 个，合并上一轮 ${extra.length} 个 → ${merged.length} 个（客户端会自行测活）`);
    }
  } catch (e) {
    console.log(`上一轮产物读取失败（忽略）：${e?.message || e}`);
  }
}
final = merged;
// 合并后按国家重新统计（后面的 logs/direct-sub.json 用它）
for (const k of Object.keys(byCc)) delete byCc[k];
for (const n of final) (byCc[n.cc] ||= []).push(n);

const generatedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'clash.yaml'), clashYaml(final), 'utf8');
fs.writeFileSync(path.join(OUT, 'xray.json'), JSON.stringify(xrayJson(final), null, 2), 'utf8');
fs.writeFileSync(path.join(OUT, 'nodes.txt'), nodesText(final), 'utf8');
// 机器可读的上一轮快照：下一轮如果只抓到一两个，用它合并（见上面那段）
fs.writeFileSync(path.join(OUT, 'nodes.json'), JSON.stringify({ generated_at: generatedAt, nodes: final }, null, 1), 'utf8');
fs.writeFileSync(path.resolve(ROOT, 'logs/direct-sub.json'), JSON.stringify({
  generated_at: generatedAt,
  countries: COUNTRIES, max_ms: MAX_MS,
  total: final.length, by_country: Object.fromEntries(Object.entries(byCc).map(([k, v]) => [k, v.length])),
  nodes: final,
}, null, 2));

console.log(`\n写入 ${OUT}`);
console.log(`  clash.yaml  ${final.length} 个直连代理`);
console.log(`  xray.json   socks 10800~${10800 + final.length - 1}`);
console.log(`  nodes.txt   人读清单`);

/* --------------------- 挂到概览页（data.direct） ---------------------
 * 概览页是用户唯一会 bookmark 的地方，直连节点必须在那里能看到，
 * 否则这批「快一个数量级」的节点等于没交付。
 *
 * 顺序耦合要注意：CI 里 run.mjs 先写 data.json + index.html，本脚本后跑，
 * 所以这里要**重渲染一次** index.html，否则页面还是上一版（没有直连面板）。
 * 没有 data.json（例如单独跑本脚本）时跳过，不影响产物。
 */
try {
  const dataPath = path.resolve(ROOT, 'public/data.json');
  if (fs.existsSync(dataPath)) {
    const { renderIndexHtml } = await import('../src/render.mjs');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    data.direct = {
      generated_at: generatedAt,
      site: SITE,
      max_ms: MAX_MS,
      total: final.length,
      nodes: final,
    };
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 1), 'utf8');
    fs.writeFileSync(path.resolve(ROOT, 'public/index.html'), renderIndexHtml(data), 'utf8');
    console.log(`  概览页已挂上直连面板（${final.length} 个）`);
  } else {
    console.log('  没有 public/data.json，跳过概览页挂载');
  }
} catch (e) {
  // 挂载失败不该让整步失败：直连产物已经写好，主订阅照常发布
  console.log(`  挂载概览页失败（不影响直连产物）：${e?.message || e}`);
}

process.exit(0);
