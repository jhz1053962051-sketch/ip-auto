/**
 * 用线上 Worker 批量测每个节点 —— 得到「Worker 视角」的真实延迟。
 *
 * 为什么这个指标才是关键：
 *   本地 probe 测的是「本机 → 7897 → SSTP 节点」，跟用户实际路径（本机 → CF colo → Worker → 节点）完全不同。
 *   Worker 部署在 HKG colo，它到日韩住宅节点的距离，跟我们从大陆经代理过去完全是两回事。
 *   `/admin/check` 就是在 Worker 里跑一遍 sstpConnect + CONNECT cloudflare.com:443 + trace，
 *   它返回的 responseTime 就是「Worker 建链 + 出网」的真实成本。
 *   按这个排序，用户拿到的才是真正快的节点。
 *
 * 用法：node scripts/rank-by-worker.mjs [--nodes public/nodes.txt] [--concurrency 6] [--limit 0]
 */
import fs from 'node:fs';
import {httpRequest, parseProxy} from '../src/http.mjs';
import {findAdminPassword, findEdgeBase} from '../src/secret.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const NODES = arg('nodes', 'public/nodes.txt');
const BASE = arg('base', findEdgeBase());
// 密码不写死在脚本里（仓库公开），依次取环境变量 / logs/pages-edge.json
const PASSWORD = arg('password', findAdminPassword());
if (!PASSWORD) { console.error('缺少管理员密码：设置 IP_AUTO_ADMIN 或保留 logs/pages-edge.json'); process.exit(1); }
/** edgetunnel 的 auth cookie = MD5MD5(UA + 加密秘钥 + 管理员密码)，**与 UA 强绑定**。
 *  用 A 的 UA 登录拿到的 cookie，换 B 的 UA 去请求会被判为空 → 302 到 /login（响应体「重定向中...」）。
 *  所以登录与后续请求必须用同一个固定的 UA 字符串，这里统一写死。 */
const UA = arg('ua', 'rank-worker/1.0');
const CONCURRENCY = Number(arg('concurrency', '6'));
const LIMIT = Number(arg('limit', '0'));
const TIMEOUT = Number(arg('timeout', '30000'));
const OUT = arg('out', 'logs/worker-rank.json');

// /admin/check 不经过 7897 也能通（pages.dev 直连 OK），但偶发 TLS 超时，
// 给一点重试余量；走直连能测到真实路径，所以默认不走代理
const PROXY = arg('proxy', '') ? parseProxy(arg('proxy')) : null;

function parseNodeLine(line) {
  // 格式：entry:port#国家-类型-NN$proto://[user:pass@]host:port
  const m = /^([^#]+)#([^$]+)\$(.+)$/.exec(line.trim());
  if (!m) return null;
  return {entry: m[1], name: m[2], link: m[3]};
}

async function login() {
  const res = await httpRequest(`${BASE}/login`, {
    proxy: PROXY,
    method: 'POST',
    timeoutMs: 25000,
    headers: {'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA},
    body: `password=${encodeURIComponent(PASSWORD)}`,
  });
  // 注意：http.mjs 返回的 headers 是 {key: value} 对象，set-cookie 的值里没有 "set-cookie:" 前缀，
  // 所以不能拿 /set-cookie:\s*(auth=...)/ 去匹配整个字符串 —— 直接找 auth=。
  const raw = res.headers?.['set-cookie'];
  const headerStr = Array.isArray(raw) ? raw.join('; ') : String(raw || '');
  const m = /(auth=[A-Za-z0-9]+)/.exec(headerStr);
  const cookie = m ? m[1] : null;
  if (!cookie) throw new Error(`登录失败 HTTP ${res.status}: ${String(res.body || '').slice(0, 120)}`);
  return cookie;
}

async function checkOne(node) {
  const t0 = Date.now();
  const q = new URLSearchParams();
  // /admin/check 接受 sstp=/http=/socks5= 等形式
  const m = /^(sstp|http|https|socks5|turn):\/\/(.+)$/i.exec(node.link);
  if (!m) return {...node, ok: false, error: '协议无法识别'};
  const proto = m[1].toLowerCase();
  q.set(proto, m[2]);
  const url = `${BASE}/admin/check?${q}`;
  try {
    const res = await httpRequest(url, {
      proxy: PROXY,
      timeoutMs: TIMEOUT,
      headers: {cookie: COOKIE, 'user-agent': UA},
    });
    const body = res.body ? res.body.trim() : '';
    let j = null;
    try { j = JSON.parse(body); } catch {}
    const wall = Date.now() - t0;
    if (j && j.success) {
      return {...node, ok: true, worker_ms: j.responseTime ?? null, loc: j.loc || null, ip: j.ip || null, wall};
    }
    return {...node, ok: false, error: (j && (j.error || j.message)) || body.slice(0, 80) || `HTTP ${res.status}`, wall};
  } catch (e) {
    return {...node, ok: false, error: String(e.message || e).slice(0, 100), wall: Date.now() - t0};
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  return new Promise(resolve => {
    const next = () => {
      if (i >= items.length) return;
      const k = i++;
      fn(items[k], k).then(r => out[k] = r).catch(e => out[k] = {ok: false, error: String(e?.message || e)}).finally(() => {
        if (++done === items.length) resolve(out); else next();
      });
    };
    for (let n = 0; n < Math.min(limit, items.length); n++) next();
  });
}

const lines = fs.readFileSync(NODES, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
let nodes = lines.map(parseNodeLine).filter(Boolean);
if (LIMIT > 0) nodes = nodes.slice(0, LIMIT);
console.log(`节点 ${nodes.length} 个，并发 ${CONCURRENCY}，${PROXY ? '经代理' : '直连'}…`);

let COOKIE = arg('cookie', '');
if (!COOKIE) {
  COOKIE = await login();
  console.log(`已登录，cookie=${COOKIE.slice(0, 12)}…`);
}

const t0 = Date.now();
let finished = 0;
const results = await pool(nodes, CONCURRENCY, async n => {
  const r = await checkOne(n);
  finished++;
  const tag = r.ok ? `OK ${String(r.worker_ms).padStart(5)}ms ${r.loc || ''}` : `FAIL ${(r.error || '').slice(0, 46)}`;
  console.log(`[${String(finished).padStart(3)}/${nodes.length}] ${(n.name + ' '.repeat(Math.max(0, 16 - n.name.length)))} ${tag}`);
  return r;
});

const ok = results.filter(r => r.ok);
const bad = results.filter(r => !r.ok);
console.log(`\n可用 ${ok.length}/${results.length}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (ok.length) {
  const lat = ok.map(r => r.worker_ms).filter(v => typeof v === 'number').sort((a, b) => a - b);
  const p = q => lat[Math.floor((lat.length - 1) * q)];
  console.log(`Worker 侧延迟：min=${lat[0]}ms p25=${p(0.25)}ms p50=${p(0.5)}ms p75=${p(0.75)}ms max=${lat[lat.length - 1]}ms`);
  console.log('\n最快十个：');
  ok.sort((a, b) => (a.worker_ms ?? 1e9) - (b.worker_ms ?? 1e9)).slice(0, 10).forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${(r.name + ' '.repeat(Math.max(0, 18 - r.name.length)))} ${String(r.worker_ms).padStart(5)}ms  ${r.loc || '-'}  ${r.entry}`);
  });
}

const byLoc = {};
for (const r of ok) (byLoc[r.loc || '??'] ||= []).push(r.worker_ms);
console.log('\n按地区：');
for (const [loc, arr] of Object.entries(byLoc)) {
  const s = arr.filter(v => typeof v === 'number').sort((a, b) => a - b);
  console.log(`  ${loc}  n=${s.length}  min=${s[0]}ms  p50=${s[Math.floor(s.length / 2)]}ms  max=${s[s.length - 1]}ms`);
}
if (bad.length) {
  const errs = {};
  for (const b of bad) {
    const k = String(b.error || '').replace(/\d+/g, 'N').slice(0, 60);
    errs[k] = (errs[k] || 0) + 1;
  }
  console.log('\n失败原因：');
  for (const [k, v] of Object.entries(errs).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}x  ${k}`);
}

fs.mkdirSync('logs', {recursive: true});
fs.writeFileSync(OUT, JSON.stringify({generated_at: new Date().toISOString(), total: results.length, ok: ok.length, results}, null, 2));
console.log('\n写入 ' + OUT);
process.exit(0);
