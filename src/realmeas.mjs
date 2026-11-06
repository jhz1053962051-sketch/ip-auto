/**
 * 实测「客户端真实延迟」——全链路 TTFB，用户能感受到的那个数字。
 *
 * 为什么必须是它：
 *   - `latency_ms`（src/probe.mjs）是建链总耗时：DoH + SSTP TLS + PPP(LCP/PAP/IPCP)
 *     + 隧道内 TCP + HTTP。1.9~6s 都算正常，拿它当延迟是误用。
 *   - `worker_ms`（Worker 侧 /admin/check）只覆盖「Worker→节点」这一段，
 *     不含「浏览器→CF colo」，比实机乐观约 1.2s。
 *   - `real_ms` 才是「浏览器→CF colo→Worker→节点→目标站」的端到端 TTFB。
 *
 * ⚠️ 血泪教训：**每个节点必须独立一个 Xray 进程**。
 *   曾经把 N 个 vless outbound 塞进同一个 Xray 进程（各自 socks inbound + routing 分流），
 *   同一个 UUID 的多个出站会**互相踢连接**：头几个节点直接 FAIL，后面的数字乱跳
 *   （同一节点 1411ms / 17751ms 都可能出现）。那轮"住宅节点 2.2~3.0s 地板"的结论
 *   就是被这个 bug 污染出来的 —— 独立进程重测后 55/55 全部可测，中位 401ms。
 *
 * ⚠️ 第二个坑：**不要 shell 出去调 curl 测隧道**。
 *   某些环境里的 `curl.exe` 会被外层拦截层接管、忽略 `-x`/`--socks5-hostname`
 *   （拿一个没人监听的端口 9 当代理也照样返回 200），于是测出来的是拦截层自己的延迟。
 *   曾经因此得出「中位 431ms / 最快 151ms」的假结论，用进程内 SOCKS5 才是真值：
 *   同一个节点 3.0~3.6s —— 因为 Worker 要等首包才开始 SSTP+PPP 建链，
 *   这段成本落在客户端看到的 TLS 握手时间里。
 *   → 现在统一走 src/socksprobe.mjs（进程内握手），并且**校验出口国家**：
 *   出口 loc 与节点名不符（尤其落到 CN）一律判 FAIL，避免把"回落直连"当成节点可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { socksHttpGet, parseTrace } from './socksprobe.mjs';

const TARGET_HOST = 'cloudflare.com';
const TARGET_PATH = '/cdn-cgi/trace';

/** 节点名 → 期望出口国家码 */
const CC_BY_PREFIX = { 日本: 'JP', 韩国: 'KR', 新加坡: 'SG', 美国: 'US', 香港: 'HK', 台湾: 'TW' };
function expectCc(name) {
  for (const [prefix, cc] of Object.entries(CC_BY_PREFIX)) {
    if (String(name || '').startsWith(prefix)) return cc;
  }
  return null;
}

/** 解析一行 vless，取出客户端需要的全部字段 */
export function parseVlessLine(line, fallbackHost = 'ipauto-edge.pages.dev') {
  const m = /^vless:\/\/([^@]+)@([^:]+):(\d+)\?([^#]*)#?(.*)$/.exec(String(line).trim());
  if (!m) return null;
  const [, uuid, entry, port, qs, name] = m;
  const q = new URLSearchParams(qs);
  return {
    uuid,
    entry,
    port: Number(port),
    name: decodeURIComponent(name || ''),
    path: q.get('path') || '/',
    host: q.get('host') || fallbackHost,
    sni: q.get('sni') || fallbackHost,
    fp: q.get('fp') || 'chrome',
    alpn: q.get('alpn') || '',
    security: q.get('security') || 'tls',
    type: q.get('type') || 'ws',
  };
}

/** 单节点 Xray 配置：1 个 socks inbound + 1 个 vless outbound */
export function buildOneConfig(n, port) {
  const stream = {
    network: 'ws',
    security: n.security === 'tls' ? 'tls' : 'none',
    wsSettings: { path: n.path, headers: { Host: n.host } },
  };
  if (n.security === 'tls') {
    stream.tlsSettings = { serverName: n.sni, allowInsecure: true };
    if (n.alpn) stream.tlsSettings.alpn = n.alpn.split(',').map((s) => s.trim()).filter(Boolean);
    if (n.fp) stream.tlsSettings.fingerprint = n.fp;
  }
  return {
    log: { loglevel: 'error' },
    inbounds: [{ tag: 'in', port, listen: '127.0.0.1', protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
    outbounds: [
      {
        tag: 'out',
        protocol: 'vless',
        settings: { vnext: [{ address: n.entry, port: n.port, users: [{ id: n.uuid, encryption: 'none' }] }] },
        streamSettings: stream,
      },
      { tag: 'direct', protocol: 'freedom' },
    ],
    routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', inboundTag: ['in'], outboundTag: 'out' }] },
  };
}

/**
 * 经 socks5 探一次 /cdn-cgi/trace：既拿 TTFB，也拿出口 IP 与落地国家。
 * 只有出口国家与节点名一致才算可用（否则可能就是 Worker 回落直连）。
 * @returns {Promise<{ms:number, loc:string, ip:string, colo:string}|{error:string, loc?:string}>}
 */
async function probePort(port, { timeoutMs, expect, attempt = 2 }) {
  // timeoutMs 的老语义是「秒」（沿用 curl --max-time 的写法），这里换成毫秒并给下限
  const budgetMs = Math.max(8000, Number(timeoutMs) * 1000);
  let lastErr = null;
  for (let i = 0; i < attempt; i++) {
    try {
      const r = await socksHttpGet(port, TARGET_HOST, TARGET_PATH, { timeoutMs: budgetMs });
      const tr = parseTrace(r.body);
      if (r.status !== 200 || !tr.ip) { lastErr = `HTTP ${r.status}`; continue; }
      if (expect && tr.loc && tr.loc !== expect) {
        return { error: `出口 ${tr.loc}（预期 ${expect}）`, loc: tr.loc };
      }
      return { ms: Math.round(r.ttfb_ms), loc: tr.loc || '', ip: tr.ip, colo: tr.colo || '' };
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { error: lastErr || '未知错误' };
}

/**
 * 对一批节点逐个独立进程测 TTFB。
 * @param {Array} nodes 每项含 {vless} 或可解析的 vless 字符串
 * @returns {Promise<Array<{name,real,real_ms,matched}>>} 顺序与入参一致
 */
export async function measureReal(nodes, {
  root,
  bin,
  basePort = 12000,
  concurrency = 3,
  timeoutMs = 20,
  startupMs = 2500,
  target = TARGET_HOST,
  log = () => {},
  onProgress = null,
} = {}) {
  const cfgDir = path.join(root, 'logs', 'xray-real');
  fs.mkdirSync(cfgDir, { recursive: true });

  const parsed = nodes
    .map((n, i) => ({ i, line: typeof n === 'string' ? n : n?.vless, n }))
    .filter((x) => x.line && String(x.line).startsWith('vless://'));
  const use = parsed.map((x) => ({ ...x, cfg: parseVlessLine(x.line) })).filter((x) => x.cfg);

  const results = new Array(use.length).fill(null);
  let cursor = 0;
  let done = 0;

  async function testOne(idx) {
    const item = use[idx];
    const port = basePort + idx;
    const cfgPath = path.join(cfgDir, `n${idx}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(buildOneConfig(item.cfg, port), null, 1), 'utf8');
    const child = spawn(bin, ['run', '-c', cfgPath], { cwd: root, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, startupMs));
      results[idx] = await probePort(port, { timeoutMs, expect: expectCc(item.cfg.name) });
      return results[idx];
    } finally {
      try { child.kill(); } catch { /* 已退出 */ }
    }
  }

  async function worker() {
    while (cursor < use.length) {
      const idx = cursor++;
      const r = await testOne(idx);
      done++;
      const item = use[idx];
      const real = item.n?.real || `${item.cfg.entry}:${item.cfg.port}`;
      const ms = r && Number.isFinite(r.ms) ? r.ms : null;
      const note = r && r.error ? `FAIL ${r.error}` : ms === null ? 'FAIL' : `${ms}ms ${r.loc} ${r.ip}`;
      log(`[real] ${done}/${use.length} ${item.cfg.name.padEnd(16)} ${note}`);
      if (onProgress) onProgress(done, use.length, { name: item.cfg.name, real, real_ms: ms });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, use.length)) }, worker));
  // 等端口释放，避免下一轮 EADDRINUSE
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

  const flat = [];
  for (const [idx, item] of use.entries()) {
    const r = results[idx] || {};
    flat.push({
      name: item.cfg.name,
      real: item.n?.real || `${item.cfg.entry}:${item.cfg.port}`,
      real_ms: Number.isFinite(r.ms) ? r.ms : null,
      real_loc: r.loc || '',
      real_ip: r.ip || '',
      real_colo: r.colo || '',
      real_error: r.error || (Number.isFinite(r.ms) ? '' : 'FAIL'),
      matched: !!item.n?.real,
    });
  }
  const vals = flat.filter((x) => Number.isFinite(x.real_ms)).map((x) => x.real_ms).sort((a, b) => a - b);
  return {
    flat,
    matched: vals.length,
    total: use.length,
    median: vals.length ? vals[Math.floor(vals.length / 2)] : null,
    min: vals.length ? vals[0] : null,
  };
}

/** 把测得的 real_ms 按 host:port 写回节点数组（原地改） */
export function applyRealMs(nodes, flat) {
  const byAddr = new Map();
  for (const it of flat) {
    if (!Number.isFinite(it.real_ms)) continue;
    byAddr.set(it.real, it);
  }
  let hit = 0;
  for (const n of nodes) {
    // 优先用节点真身的地址（n.real，如 vpn123.opengw.net:1524）；
    // 退回 host:port 只对直连类节点成立 —— 走 CF 的节点 host 是边缘 IP（104.26.x.x），会撞车。
    const it = byAddr.get(n.real) || byAddr.get(`${n.host}:${n.port}`);
    if (it) {
      n.real_ms = it.real_ms;
      if (it.real_loc) n.real_loc = it.real_loc;
      if (it.real_ip) n.real_ip = it.real_ip;
      hit++;
    }
  }
  return hit;
}
