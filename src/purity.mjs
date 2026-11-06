/**
 * IP 纯净度（欺诈分）查询。
 *
 * 为什么需要这个：
 *   项目原来只用 ip-api 的 hosting 字段把节点分成「住宅 / 机房」，并默认住宅更好。
 *   实测 60 个出口 IP 后发现这个假设是错的 —— 欺诈分与住宅/机房几乎无关，甚至反向：
 *     住宅组 p50 明显更高；SoftEther 那批 `219.100.37.x`（共享 VPN 出口，万人骑）
 *     fraud 17~86；而阿里云 / 微软 / Azure 机房节点大量 fraud = 0。
 *   也就是说「住宅 IP」≠「干净 IP」，很多住宅节点在风控系统眼里比机房更脏。
 *
 * 数据源：Scamalytics 网页（免费、无 key）。实测并发 4 连打 7 个无 429、无 CF 挑战页。
 *   页面里固定两处可抓：
 *     <div class="score">Fraud Score: 100</div>
 *     We consider <b>web traffic</b> from IP address <b>1.2.3.4</b> to present a potentially <b>very high</b> fraud risk.
 *   注意：紧随其后的 `operated by <b>SOFTBANK</b> whose web traffic we consider to present a potential
 *   `low` fraud risk` 说的是「运营商整体」，不是这个 IP；取错会把全部节点判成 low。
 *   所以 risk 只在「web traffic from IP」那一句里取。
 *
 * 分级（沿用参考文献 fq-book/docs/abc/pure.md 的口径）：
 *   0~24 干净 · 25~49 一般 · 50~74 可疑 · 75~100 很脏
 *
 * 参考：https://github.com/hoochanlon/fq-book（无 LICENSE，只借鉴思路，未复制代码）
 */
import { httpRequest } from './http.mjs';
import { mapPool, withRetry } from './pool.mjs';

export const SCAM_BASE = 'https://scamalytics.com/ip/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** fraud 分档：页面着色与排序都用这个 */
export const PURITY_LEVELS = [
  { key: 'clean', max: 24, label: '干净', tone: 'ok' },
  { key: 'fair', max: 49, label: '一般', tone: 'dim' },
  { key: 'dirty', max: 74, label: '可疑', tone: 'warn' },
  { key: 'bad', max: 100, label: '很脏', tone: 'bad' },
];

export function purityLevel(fraud) {
  if (!Number.isFinite(fraud)) return null;
  return PURITY_LEVELS.find((l) => fraud <= l.max) || PURITY_LEVELS[PURITY_LEVELS.length - 1];
}

/**
 * 解析 Scamalytics 页面。
 * @returns {{fraud:number|null, risk:string|null, operator:string|null, challenge:boolean}}
 */
export function parseScamalytics(html) {
  const body = String(html || '');
  const m =
    body.match(/Fraud Score:\s*(\d{1,3})/) ||
    body.match(/class="score"[^>]*>[^0-9]{0,40}(\d{1,3})/) ||
    body.match(/Fraud Score[^0-9]{0,80}(\d{1,3})/) ||
    // 干净 IP 的页面往往没有 score 那块，但正文里一定有 "apply a risk score of 0/100"
    body.match(/apply a risk score of\s*(\d{1,3})\s*\/\s*100/i);
  const fraud = m ? Number(m[1]) : null;

  // 页面里 "web traffic" 会出现 2~3 次，句子结构有两种，必须分开认：
  //   A) 有该 IP 的直接观测 → "We consider web traffic from IP address <b>IP</b> to present a potentially <b>very high</b> fraud risk"
  //   B) 只有运营商观测   → "IP address <b>IP</b> is operated by <b>OP</b> whose web traffic we consider to present a potentially <b>low</b> fraud risk"
  // 两种都是合法信息，但 B 说的是「运营商整体」，不是这个 IP 本身，所以额外记 risk_scope。
  const ipRisk = body.match(
    /web traffic\s*<\/b>\s*from IP address[\s\S]{0,200}?potentially\s*<b>([^<]{2,20})<\/b>\s*fraud risk/i
  );
  const opRisk = body.match(
    /is operated by[\s\S]{0,240}?potentially\s*<b>([^<]{2,20})<\/b>\s*fraud risk/i
  );
  const risk = ipRisk ? ipRisk[1].trim().toLowerCase() : opRisk ? opRisk[1].trim().toLowerCase() : null;
  const risk_scope = ipRisk ? 'ip' : opRisk ? 'operator' : null;

  const om = body.match(/is operated by\s*<b>([^<]+)<\/b>/i);
  const operator = om ? om[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : null;

  // CF 挑战页 / 被拦的特征；出现时宁可当失败，也不要当「0 分很干净」
  const challenge =
    /Just a moment\.\.\.|cf-challenge|Enable JavaScript and cookies|Attention Required! \| Cloudflare/i.test(body);

  return {
    fraud: Number.isFinite(fraud) && fraud >= 0 && fraud <= 100 ? fraud : null,
    risk,
    risk_scope,
    operator,
    challenge,
  };
}

/**
 * 查单个 IP 的欺诈分。失败返回 {ok:false, error}，绝不抛（流水线里一个 IP 失败不该拖垮整轮）。
 *
 * @param {string} ip
 * @param {{proxy?:{host:string,port:number}|null, timeoutMs?:number, attempts?:number, log?:Function}} opts
 */
export async function probePurity(ip, { proxy = null, timeoutMs = 20000, attempts = 2, log = null } = {}) {
  const clean = String(ip || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return { ip: clean, ok: false, error: '不是 IPv4' };

  const t0 = Date.now();
  try {
    const r = await withRetry(
      () =>
        httpRequest(`${SCAM_BASE}${clean}`, {
          proxy,
          timeoutMs,
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        }),
      { attempts, delayMs: 600 }
    );
    const p = parseScamalytics(r.body);
    const ms = Date.now() - t0;
    if (r.status !== 200) return { ip: clean, ok: false, status: r.status, ms, ...p };
    if (p.challenge) return { ip: clean, ok: false, error: 'CF 挑战页', status: r.status, ms, ...p };
    if (p.fraud == null) return { ip: clean, ok: false, error: '页面里没找到 Fraud Score', status: r.status, ms, ...p };
    return { ip: clean, ok: true, status: r.status, ms, ...p };
  } catch (e) {
    return { ip: clean, ok: false, error: e?.message || String(e), ms: Date.now() - t0 };
  }
}

/**
 * 批量查一批 IP（自动去重、限并发）。
 * @param {string[]} ips
 * @param {{proxy?:object|null, concurrency?:number, timeoutMs?:number, log?:Function, onProgress?:Function}} opts
 * @returns {Promise<Map<string,{fraud:number|null, risk:string|null, operator:string|null, ok:boolean}>>}
 */
export async function probePurityBatch(ips, { proxy = null, concurrency = 4, timeoutMs = 20000, log = null } = {}) {
  const uniq = [...new Set((ips || []).filter(Boolean))];
  const out = new Map();
  if (!uniq.length) return out;

  let done = 0;
  const results = await mapPool(
    uniq,
    Math.max(1, Math.min(concurrency, 8)),
    async (ip) => probePurity(ip, { proxy, timeoutMs, log }),
    () => {
      done++;
      if (done % 10 === 0 || done === uniq.length) log?.(`[purity] ${done}/${uniq.length}`);
    }
  );

  for (const r of results) {
    if (!r || !r.ip) continue;
    out.set(r.ip, {
      ok: !!r.ok,
      fraud: Number.isFinite(r.fraud) ? r.fraud : null,
      risk: r.risk || null,
      operator: r.operator || null,
      error: r.ok ? undefined : r.error || `HTTP ${r.status}`,
    });
  }
  const okCount = [...out.values()].filter((v) => v.ok).length;
  log?.(`[purity] 可查 ${okCount}/${uniq.length}`);
  return out;
}

/**
 * 把批量结果写回节点对象（就地改）。
 * 节点上的出口 IP 字段有三个来源，按可靠性排序取第一个：
 *   real_ip（真 Xray 实测到的出口）> exit_ip（探测时看到的出口）> host（没测到时的兜底）
 *
 * @param {Array<object>} nodes  就地修改，写入 fraud / fraud_risk / fraud_op
 * @param {Map<string,object>} table  probePurityBatch 的返回
 * @returns {number} 命中数
 */
export function applyPurity(nodes, table) {
  let hit = 0;
  for (const n of nodes || []) {
    const ip = n.real_ip || n.exit_ip || (/^\d+\.\d+\.\d+\.\d+$/.test(String(n.host || '')) ? n.host : '');
    const r = ip ? table.get(ip) : null;
    if (!r || !r.ok || !Number.isFinite(r.fraud)) continue;
    n.fraud = r.fraud;
    n.fraud_risk = r.risk;
    n.fraud_op = r.operator;
    n.purity_ip = ip;
    hit++;
  }
  return hit;
}

/** 中位数：偶数个取中间两个的平均（fraud 是整数分，取平均比取小侧更贴近直觉） */
export function median(arr) {
  const s = (arr || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 汇总统计：给 stats 和页面统计卡用 */
export function purityStats(nodes) {
  const vals = (nodes || []).map((n) => n.fraud).filter((v) => Number.isFinite(v));
  if (!vals.length) {
    return { purity_measured: 0, fraud_median: null, fraud_clean: 0, fraud_dirty: 0, fraud_bad: 0 };
  }
  return {
    purity_measured: vals.length,
    fraud_median: median(vals),
    fraud_clean: vals.filter((v) => v <= 24).length,
    fraud_dirty: vals.filter((v) => v >= 50).length,
    fraud_bad: vals.filter((v) => v >= 75).length,
  };
}
