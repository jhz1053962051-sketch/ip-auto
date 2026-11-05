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
 * 顺带一提：socks5 入站必须配 `curl --socks5-hostname`，且**必须 `--noproxy '*'`**，
 * 否则 curl 会先走系统代理 7897，测出来的是代理的延迟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const DEFAULT_TARGET = 'https://www.gstatic.com/generate_204';

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

/** curl 一次，返回 TTFB 毫秒或 null */
function probePort(port, { timeoutMs, target, attempt = 2 }) {
  for (let i = 0; i < attempt; i++) {
    try {
      const s = execFileSync('curl', [
        '-sS', '--max-time', String(timeoutMs),
        '--noproxy', '*',
        '--socks5-hostname', `127.0.0.1:${port}`,
        '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '-w', '%{time_starttransfer} %{http_code}',
        target,
      ], { encoding: 'utf8', timeout: (timeoutMs + 6) * 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const [t, code] = s.split(' ');
      if (code === '204' || code === '200') return Math.round(Number(t) * 1000);
    } catch { /* 重试一次 */ }
  }
  return null;
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
  target = DEFAULT_TARGET,
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
      results[idx] = probePort(port, { timeoutMs, target });
      return results[idx];
    } finally {
      try { child.kill(); } catch { /* 已退出 */ }
    }
  }

  async function worker() {
    while (cursor < use.length) {
      const idx = cursor++;
      const ms = await testOne(idx);
      done++;
      const item = use[idx];
      const real = item.n?.real || `${item.cfg.entry}:${item.cfg.port}`;
      log(`[real] ${done}/${use.length} ${item.cfg.name.padEnd(16)} ${ms === null ? 'FAIL' : ms + 'ms'}`);
      if (onProgress) onProgress(done, use.length, { name: item.cfg.name, real, real_ms: ms });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, use.length)) }, worker));
  // 等端口释放，避免下一轮 EADDRINUSE
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

  const flat = [];
  for (const [idx, item] of use.entries()) {
    flat.push({
      name: item.cfg.name,
      real: item.n?.real || `${item.cfg.entry}:${item.cfg.port}`,
      real_ms: results[idx],
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
    byAddr.set(it.real, it.real_ms);
  }
  let hit = 0;
  for (const n of nodes) {
    const ms = byAddr.get(`${n.host}:${n.port}`);
    if (Number.isFinite(ms)) { n.real_ms = ms; hit++; }
  }
  return hit;
}
