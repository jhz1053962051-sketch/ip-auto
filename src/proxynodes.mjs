/**
 * 公共代理池支线：给 VPN Gate 覆盖不到的国家（典型是新加坡）供节点。
 *
 * ## 为什么需要这条支线
 * VPN Gate 的节点全在志愿者家宽上，国家分布极其集中：日本/韩国占七成，
 * 剩下是俄/越/泰/美/台/罗。新加坡**一条都没有**（实测主站与镜像均为 0）。
 * 所以 SG 只能去公共代理池捞 socks5 / http，再用 edgetunnel 的链式代理出网。
 *
 * ## 现实约束（别抱幻想）
 * 公共代理池里的新加坡，几乎全是云厂商机房（腾讯云 / 阿里云 / Azure），
 * 不是家宽。实测 113 个候选、226 个协议组合里存活 12 个、出口匹配 11 个、住宅 0 个。
 * 所以这条支线产出的节点会被标成「机房」，和日韩的家宽节点区分开。
 *
 * ## 两道关卡（缺一不可）
 *   1. `checkProxy()` —— 走 CONNECT cloudflare.com:443 + TLS + /cdn-cgi/trace，
 *      和线上 Worker 的 `admin/check` 完全同一路径（80 端口的 absolute-form 探测
 *      会造成假阳性，详见 proxycheck.mjs 顶部注释）。
 *   2. `lookupIps()` —— 用出口 IP 反查国家/ASN/hosting，只留出口真在目标国家的。
 *      公共池里「IP 注册在新加坡、实际出口在印尼」的情况很常见（实测有 82.41.42.229 → 125.166.94.245 ID）。
 */
import { fetchProxyCandidates } from './proxysrc.mjs';
import { checkProxy, parseProxyLine } from './proxycheck.mjs';
import { lookupIps } from './geo.mjs';
import { mapPool } from './pool.mjs';

/**
 * @param {string[]} countries 国家代码，如 ['SG']
 * @param {object} opt {proxy, concurrency, timeoutMs, maxPerCountry, log}
 * @returns {Promise<{nodes:object[], failed:object[], stats:object}>}
 */
export async function collectProxyNodes(countries, opt = {}) {
  const {
    proxy = null,
    concurrency = 24,
    timeoutMs = 12000,
    maxPerCountry = 260,
    log = () => {},
  } = opt;

  const wanted = (countries || []).map((c) => String(c).toUpperCase()).filter(Boolean);
  const nodes = [];
  const failed = [];
  const stats = { candidates: 0, checked: 0, alive: 0, matched: 0 };
  if (!wanted.length) return { nodes, failed, stats };

  for (const cc of wanted) {
    log(`[proxy] ${cc} 开始抓取公共代理池…`);
    const { candidates, errors } = await fetchProxyCandidates(cc, { proxy, log });
    if (errors.length) log(`[proxy] ${cc} 数据源告警 ${errors.length} 条：${errors[0]}`);
    if (!candidates.length) {
      log(`[proxy] ${cc} 没有拿到任何候选`);
      continue;
    }
    stats.candidates += candidates.length;

    // 公共池里 http 占多数，同一条 ip:port 两种协议都可能连通，都试一遍
    const targets = [];
    for (const line of candidates.slice(0, maxPerCountry)) {
      const p = parseProxyLine(line, 'http');
      if (!p || !p.host || !p.port) continue;
      targets.push({ type: 'http', host: p.host, port: p.port, user: p.user, pass: p.pass });
      targets.push({ type: 'socks5', host: p.host, port: p.port, user: p.user, pass: p.pass });
    }
    log(`[proxy] ${cc} 候选 ${candidates.length} 条 → 探测组合 ${targets.length} 个（并发 ${concurrency}，超时 ${timeoutMs}ms）`);

    let alive = 0;
    const results = await mapPool(
      targets,
      concurrency,
      (t) => checkProxy(t, { timeoutMs }),
      (done, total, r) => {
        if (r?.ok) {
          alive++;
          log(`[proxy]   OK   ${r.type} ${r.host}:${r.port} → ${r.exitIp} ${r.loc} ${r.responseTime}ms`);
        }
      },
    );

    stats.checked += results.length;
    stats.alive += alive;
    log(`[proxy] ${cc} 存活 ${alive} / ${targets.length}`);

    const aliveList = results.filter((r) => r?.ok);
    for (const r of results) {
      if (!r?.ok) failed.push({ host: r?.host, port: r?.port, protocol: r?.type, error: r?.error || 'unknown' });
    }
    if (!aliveList.length) continue;

    // 用出口 IP 反查归属，只有出口真在目标国家的才留下
    const geoMap = await lookupIps(aliveList.map((r) => r.exitIp), { proxy, timeoutMs: 20000 });
    for (const r of aliveList) {
      const rec = geoMap.get(r.exitIp);
      const actual = String(rec?.countryCode || '').toUpperCase();
      if (actual !== cc) {
        failed.push({
          host: r.host,
          port: r.port,
          protocol: r.type,
          error: `出口国家不符（${actual || '?'}）`,
        });
        continue;
      }
      stats.matched++;
      const asnMatch = String(rec?.as || '').match(/^(AS\d+)\s+(.*)$/i);
      const hosting = rec?.hosting;
      nodes.push({
        host: r.host,
        port: r.port,
        protocol: r.type,
        user: r.user || null,
        pass: r.pass || null,
        country: rec?.country || cc,
        country_code: cc,
        city: rec?.city || null,
        org: rec?.org || rec?.isp || null,
        asn: asnMatch ? asnMatch[1] : rec?.as || null,
        isp: rec?.isp || null,
        exit_ip: r.exitIp,
        residential: hosting === true ? 'datacenter' : hosting === false ? 'residential' : 'unknown',
        latency_ms: r.responseTime,
        source: 'proxy-pool',
      });
    }
    log(`[proxy] ${cc} 出口匹配 ${nodes.length} 条`);
  }

  // 同一出口 IP 只留最快的那个（公共池里重复很多）
  const best = new Map();
  for (const n of nodes) {
    const k = `${n.exit_ip}|${n.protocol}`;
    const prev = best.get(k);
    if (!prev || (n.latency_ms || 1e9) < (prev.latency_ms || 1e9)) best.set(k, n);
  }
  const deduped = [...best.values()].sort((a, b) => (a.latency_ms || 1e9) - (b.latency_ms || 1e9));
  log(`[proxy] 去重后 ${deduped.length} 条（出口 IP 去重）`);
  return { nodes: deduped, failed, stats };
}
