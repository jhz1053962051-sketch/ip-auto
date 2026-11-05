/**
 * 用线上 Worker 给节点打真实延迟分。
 *
 * 为什么必须这么做：
 *   `src/probe.mjs` 里测出来的 `latency_ms` 是「本机 → 代理 → SSTP 节点」的建链耗时，
 *   而用户实际走的是「本机 → CF colo → Worker → SSTP 节点」。两条路径完全不同：
 *   本地 probe 里最快的 SG 节点（294ms）在 Worker 视角是 16680ms，而 Worker 视角最快的
 *   日本节点（1619ms）在本地 probe 里只是个中位数。拿本地 probe 排序，等于按错的尺子排队。
 *
 * `/admin/check` 就是在 Worker 内部跑 sstpConnect + 隧道内 CONNECT cloudflare.com:443 + 读
 * /cdn-cgi/trace，返回的 `responseTime` 正是「Worker 建链 + 出网」的真实成本。
 *
 * 两个必须注意的坑：
 *   1. edgetunnel 的 auth cookie = MD5MD5(UA + 加密秘钥 + 管理员密码)，**与 UA 强绑定**。
 *      登录用的 UA 和后续请求的 UA 必须完全一致，否则一律 302 到 /login（响应体「重定向中...」）。
 *   2. `/admin/check` 一次只测一个节点、串行也行但太慢，这里并发跑；并发过高会让 Worker
 *      同时开太多 SSTP 连接，反而出现 `Stream was cancelled`。
 */
import {httpRequest, parseProxy} from './http.mjs';
import {mapPool} from './pool.mjs';
import {findAdminPassword, findEdgeBase, findUuid} from './secret.mjs';
import {EDGE_IPS} from './edges.mjs';

export const DEFAULT_BASE = findEdgeBase();
/** 管理员密码不落源码：仓库是公开的，写死等于把后台交出去。见 src/secret.mjs。 */
export const DEFAULT_PASSWORD = null;
/** 固定 UA：登录与检查必须同一个字符串，否则 cookie 校验不过。 */
export const DEFAULT_UA = 'ip-auto-rank/1.0';

/**
 * `*.pages.dev` 的直连稳定性很差：实测同一 URL 连打 5 次，2 次在 TLS 握手阶段超时
 * （`curl: (28) Connection timed out`，连 SNI 都还没换出去）。
 *
 * 但「域名解析到哪个 anycast IP」是随机的，而香港 colo 那批（`104.26.x.x`）稳定得多。
 * 所以这里保留一个**可复用的边缘 IP 列表**：第一次照常按域名连，一旦失败就改用
 * `connectIp`（连 IP、SNI 仍是域名）把请求钉在已知可用的边缘上。
 * 效果：60 个节点里 29 个 `TLS 握手超时` 的失败率会显著下降。
 *
 * 注意：这里只对 **我们自己的** `ipauto-edge.pages.dev` 生效 —— 用 IP 直连 + 域名 SNI
 * 只对 Cloudflare 自家域名有效（CF 按 SNI 选证书与路由），拿它去打别人的站会被 403。
 */
export const RANK_EDGE_IPS = EDGE_IPS;

/** 带重试的请求：第 1 次按域名，之后依次换边缘 IP。 */
async function requestWithRetry(url, {proxy, timeoutMs, headers, edgeIps, log, method = 'GET', body = null}) {
  const attempts = [null, ...(edgeIps || [])];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const connectIp = attempts[i];
    try {
      return await httpRequest(url, {
        proxy,
        timeoutMs,
        headers,
        connectIp,
        method,
        body,
        // 握手预算压到 8s：域名解析到被掐的 colo 时会静默卡满，必须快速放弃换下一个。
        // 业务时间（Worker 里建 SSTP）由 timeoutMs 覆盖，不受此限。
        connectTimeoutMs: 8000,
      });
    } catch (e) {
      lastErr = e;
      // 只对连接/握手类错误换 IP；HTTP 层的错（比如 302 到 /login）换 IP 也没用
      const msg = String(e?.message || e);
      const retriable = /超时|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|连接已关闭|响应为空/i.test(msg);
      if (!retriable) throw e;
      if (i + 1 < attempts.length) log?.(`[rank] ${msg} → 换边缘 ${attempts[i + 1]} 重试`);
    }
  }
  throw lastErr;
}

/**
 * 登录拿 auth cookie。
 * @returns {Promise<string>} 形如 `auth=xxxx`
 */
export async function loginWorker({base = DEFAULT_BASE, password = (DEFAULT_PASSWORD ?? findAdminPassword()), ua = DEFAULT_UA, proxy = null, timeoutMs = 30000, edgeIps = RANK_EDGE_IPS, log = null} = {}) {
  if (!password) throw new Error('缺少管理员密码（IP_AUTO_ADMIN 或 logs/pages-edge.json）');
  const res = await requestWithRetry(`${base}/login`, {
    proxy,
    timeoutMs,
    headers: {'content-type': 'application/x-www-form-urlencoded', 'user-agent': ua},
    edgeIps,
    log,
    method: 'POST',
    body: `password=${encodeURIComponent(password)}`,
  });
  const raw = res.headers?.['set-cookie'];
  const headerStr = Array.isArray(raw) ? raw.join('; ') : String(raw || '');
  const m = /(auth=[A-Za-z0-9]+)/.exec(headerStr);
  if (!m) throw new Error(`登录失败 HTTP ${res.status}: ${String(res.body || '').slice(0, 140)}`);
  return m[1];
}

/** 把节点对象转成 `/admin/check` 的查询串。 */
export function checkQuery(node) {
  const link = String(node.link || node.sstp || '');
  const m = /^(sstp|socks5|http|https|turn):\/\/(.+)$/i.exec(link);
  if (!m) return null;
  const q = new URLSearchParams();
  q.set(m[1].toLowerCase(), m[2]);
  return q.toString();
}

/**
 * 测单个节点。
 * @returns {Promise<{ok:boolean, worker_ms?:number, loc?:string, ip?:string, error?:string}>}
 */
export async function checkViaWorker(node, {base = DEFAULT_BASE, cookie, ua = DEFAULT_UA, proxy = null, timeoutMs = 40000, edgeIps = RANK_EDGE_IPS, log = null} = {}) {
  const qs = checkQuery(node);
  if (!qs) return {ok: false, error: '协议无法识别'};
  const t0 = Date.now();
  try {
    const res = await requestWithRetry(`${base}/admin/check?${qs}`, {
      proxy,
      timeoutMs,
      headers: {cookie, 'user-agent': ua},
      edgeIps,
      log,
    });
    const body = String(res.body || '').trim();
    let j = null;
    try { j = JSON.parse(body); } catch {}
    const wall = Date.now() - t0;
    if (j && j.success) return {ok: true, worker_ms: Number(j.responseTime) || wall, loc: j.loc || null, ip: j.ip || null, wall};
    return {ok: false, error: (j && (j.error || j.message)) || body.slice(0, 90) || `HTTP ${res.status}`, wall};
  } catch (e) {
    return {ok: false, error: String(e.message || e).slice(0, 110), wall: Date.now() - t0};
  }
}

/**
 * 批量给节点打 Worker 延迟分。原地修改每个节点的 `worker_ms` / `worker_loc` / `worker_error`。
 *
 * @param {Array} nodes 节点数组（含 link 或 sstp 字段）
 * @param {object} opt
 * @returns {Promise<{ok:number, failed:number, cookie:string, p50:number|null, min:number|null}>}
 */
export async function rankByWorker(nodes, {
  base = DEFAULT_BASE,
  password = (DEFAULT_PASSWORD ?? findAdminPassword()),
  ua = DEFAULT_UA,
  proxy = null,
  concurrency = 6,
  timeoutMs = 40000,
  edgeIps = RANK_EDGE_IPS,
  log = () => {},
  onProgress = null,
} = {}) {
  if (!nodes.length) return {ok: 0, failed: 0, cookie: null, p50: null, min: null};

  const cookie = await loginWorker({base, password, ua, proxy, timeoutMs: Math.min(timeoutMs, 30000), edgeIps, log});
  log(`Worker 排名：已登录，开始测 ${nodes.length} 个节点（并发 ${concurrency}）`);

  let done = 0;
  const results = await mapPool(nodes, concurrency, async (n) => {
    const r = await checkViaWorker(n, {base, cookie, ua, proxy, timeoutMs, edgeIps, log});
    done++;
    if (onProgress) onProgress(done, nodes.length, r, n);
    return r;
  });

  let ok = 0, failed = 0;
  const lat = [];
  nodes.forEach((n, i) => {
    const r = results[i] || {ok: false, error: '未知'};
    if (r.ok && Number.isFinite(r.worker_ms)) {
      n.worker_ms = r.worker_ms;
      n.worker_loc = r.loc || null;
      if (r.ip) n.worker_exit_ip = r.ip;
      delete n.worker_error;
      ok++;
      lat.push(r.worker_ms);
    } else {
      n.worker_ms = null;
      n.worker_error = r.error || '失败';
      failed++;
    }
  });

  lat.sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null;
  log(`Worker 排名完成：成功 ${ok} / 失败 ${failed}，中位 ${p50 === null ? '—' : p50 + 'ms'}`);
  return {ok, failed, cookie, p50, min: lat.length ? lat[0] : null};
}

/** 按 Worker 延迟排序（没测到的排最后，保持原顺序做次键）。 */
export function sortByWorker(nodes) {
  return [...nodes].sort((a, b) => {
    const av = Number.isFinite(a.worker_ms) ? a.worker_ms : Infinity;
    const bv = Number.isFinite(b.worker_ms) ? b.worker_ms : Infinity;
    if (av !== bv) return av - bv;
    return (a.latency_ms || 1e9) - (b.latency_ms || 1e9);
  });
}
