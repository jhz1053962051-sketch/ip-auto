/**
 * 本地站点渲染：把一份 data.json 渲染成自包含的 index.html。
 *
 * 设计目标：**在浏览器里一眼看懂、一条即复制**。
 *  - 顶部直接把订阅地址摆出来（点一下复制、或直接点「打开」看原文）
 *  - 每个节点都带「复制 vless」和「复制 SSTP」两种链接：
 *    · vless 给 v2rayN / Clash Meta / sing-box 这类客户端，走 Cloudflare 入口
 *    · SSTP 给只认链路端点的场景，直连那台住宅机器
 *  - 纯内联 CSS/JS，无外部资源、无 CDN，双击能看、也能直接放 GitHub Pages
 *
 * 数据来自 `src/run.mjs`：`data.subscription`（host/uuid/token/三个订阅地址）
 * 与 `data.vless_nodes`（已排好序、带 vless 链接的节点列表）。
 * 两者缺省时回落到只看 `data.countries`，老 data.json 也能渲染。
 */
import { COUNTRY_ZH, nodeLink, protoLabel } from './edges.mjs';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmtMs = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '—');

const FLAG = {
  JP: '🇯🇵', KR: '🇰🇷', TH: '🇹🇭', TW: '🇹🇼', HK: '🇭🇰', SG: '🇸🇬', US: '🇺🇸', VN: '🇻🇳',
  RU: '🇷🇺', FR: '🇫🇷', DE: '🇩🇪', GB: '🇬🇧', CA: '🇨🇦', AU: '🇦🇺', IN: '🇮🇳', ID: '🇮🇩',
  MY: '🇲🇾', PH: '🇵🇭', BR: '🇧🇷', AR: '🇦🇷', TR: '🇹🇷', UA: '🇺🇦', PL: '🇵🇱', NL: '🇳🇱',
  IT: '🇮🇹', ES: '🇪🇸', SE: '🇸🇪', NO: '🇳🇴', FI: '🇫🇮', DK: '🇩🇰', CH: '🇨🇭', AT: '🇦🇹',
  CZ: '🇨🇿', RO: '🇷🇴', MX: '🇲🇽', CL: '🇨🇱', ZA: '🇿🇦', EG: '🇪🇬', IR: '🇮🇷', KZ: '🇰🇿',
};

/** 有 vless_nodes 就用它（顺序已定）；否则从 countries 现场拼一份不含 vless 的 */
function collectNodes(data) {
  if (Array.isArray(data.vless_nodes) && data.vless_nodes.length) {
    return data.vless_nodes.map((n) => ({ ...n, cc: ccOf(n.name) }));
  }
  const out = [];
  for (const g of Object.values(data.countries || {})) {
    const code = String(g.code || '??').toUpperCase();
    for (const n of g.nodes || []) {
      out.push({
        name: `${COUNTRY_ZH[code] || g.name || code}-${n.residential === 'residential' ? '住宅' : '机房'}`,
        cc: code,
        entry: `${n.host}:${n.port}`,
        real: `${n.host}:${n.port}`,
        exit_ip: n.exit_ip || '',
        org: n.org || '',
        latency_ms: n.latency_ms,
        worker_ms: Number.isFinite(n.worker_ms) ? n.worker_ms : null,
        real_ms: Number.isFinite(n.real_ms) ? n.real_ms : null,
        residential: n.residential === 'residential',
        vless: '',
        protocol: String(n.protocol || n.proto || 'sstp').toLowerCase(),
        sstp: nodeLink(n),
      });
    }
  }
  return out;
}

/** 从节点名 `日本-住宅-01` 反推国家代码，用于分组和国旗 */
function ccOf(name) {
  const zh = String(name || '').split('-')[0];
  for (const [code, label] of Object.entries(COUNTRY_ZH)) if (label === zh) return code;
  return '??';
}

/**
 * 直连节点面板：http/socks5 代理，客户端原生支持，不经过 Cloudflare。
 *
 * 为什么单独一块而不是混进上面的表：这两类节点性质完全不同 ——
 *  - 上面的 vless/SSTP 走「客户端 → CF colo → Worker → 住宅」，稳定但每跳串行，有 ~2.5s 地板；
 *  - 这里的 http 代理直连，实测能省 600~700ms，但来自公共池，随时会失效，
 *    而且部分代理做了 TLS 拦截（证书不受信），不适合当唯一出口。
 * 混在一起会让人以为「住宅节点只要 300ms」，所以必须分区展示。
 */
function renderDirectPanel(data) {
  const d = data && data.direct;
  if (!d || !Array.isArray(d.nodes) || !d.nodes.length) return '';

  const site = String(d.site || '').replace(/\/+$/, '');
  const clashUrl = site ? `${site}/direct/clash.yaml` : 'direct/clash.yaml';
  const byCc = {};
  for (const n of d.nodes) (byCc[n.cc] ??= []).push(n);
  const order = Object.keys(byCc).sort((a, b) => byCc[b].length - byCc[a].length);

  const rows = d.nodes.map((n, i) => `<tr>
      <td class="mono dim">${String(i + 1).padStart(2, '0')}</td>
      <td class="nm">${FLAG[n.cc] || '🌐'} ${esc(COUNTRY_ZH[n.cc] || n.cc)}</td>
      <td class="mono">${esc(String(n.proto || '').toUpperCase())}</td>
      <td><span class="badge ${n.residential === 'residential' ? 'resi' : 'dc'}">${n.residential === 'residential' ? '住宅' : '机房'}</span></td>
      <td class="mono">${esc(`${n.host}:${n.port}`)}</td>
      <td class="mono"><b style="color:var(--acc)">${Math.round(n.direct_ms)} ms</b></td>
      <td class="mono">${esc(n.exitIp || '—')}</td>
      <td class="mono dim org">${esc(n.org || '—')}</td>
      <td class="acts"><code class="copy" data-copy="${esc(`${n.host}:${n.port}`)}">复制地址</code></td>
    </tr>`).join('');

  return `<section class="card">
    <header>
      <h2>⚡ 直连节点 <span class="code">${d.nodes.length} 个 · 不经 Cloudflare</span></h2>
      <div class="pills">
        ${order.map((cc) => `<span class="pill">${FLAG[cc] || '🌐'} ${esc(COUNTRY_ZH[cc] || cc)} ${byCc[cc].length}</span>`).join('')}
        ${site ? `<a class="open" href="${esc(clashUrl)}" target="_blank" rel="noreferrer">打开 clash.yaml</a>
        <span class="copy pill btn" data-copy="${esc(clashUrl)}">复制订阅</span>` : ''}
      </div>
    </header>
    <div style="padding:12px 18px;color:var(--dim);font-size:12.5px;line-height:1.8;border-bottom:1px solid #1a2432">
      http / socks5 代理，客户端<b style="color:var(--acc2)">原生支持、直连不绕 Worker</b>，实测比走 Cloudflare 快 600~700ms。<br>
      代价：来自公共代理池，<b style="color:var(--warn)">随时可能失效</b>；部分代理会做 TLS 拦截（证书不受信），
      小请求（网页/API）可用，<b style="color:var(--warn)">不保证能看视频</b>。要稳定住宅出口请用上面那批。
    </div>
    <table>
      <thead><tr><th>#</th><th>地区</th><th>类型</th><th>出口</th><th>地址</th><th>直连延迟</th><th>出口 IP</th><th>ASN / 组织</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderNodeTable(nodes) {
  const rows = nodes.map((n, i) => `<tr>
      <td class="mono dim">${String(i + 1).padStart(2, '0')}</td>
      <td class="nm">${esc(n.name)} <span class="badge ${n.residential ? 'resi' : 'dc'}">${n.residential ? '住宅' : '机房'}</span></td>
      <td class="mono">${esc(n.entry)}</td>
      <td class="mono dim">${esc(n.real)}</td>
      <td class="mono">${esc(n.exit_ip || '—')}</td>
      <td class="mono dim org">${esc(n.org || '—')}</td>
      <td class="mono">${fmtMs(n.worker_ms ?? n.latency_ms)}</td>
      <td class="mono dim">${Number.isFinite(n.real_ms) ? `${Math.round(n.real_ms)} ms` : '—'}</td>
      <td class="acts">
        ${n.vless ? `<code class="copy" data-copy="${esc(n.vless)}">复制 vless</code>` : ''}
        <code class="copy" data-copy="${esc(n.sstp)}">复制 ${protoLabel(n)}</code>
      </td>
    </tr>`).join('');

  return `<table>
      <thead><tr><th>#</th><th>名称</th><th>入口（Cloudflare）</th><th>真实出口</th><th>出口 IP</th><th>ASN / 组织</th><th>延迟（Worker 实测）</th><th>实机实测</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function renderIndexHtml(data) {
  const s = data.stats || {};
  const nodes = collectNodes(data);
  const sub = data.subscription || null;

  const groups = {};
  for (const n of nodes) (groups[n.cc] ??= []).push(n);
  const order = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);

  const cards = order
    .map((cc) => {
      const zh = COUNTRY_ZH[cc] || cc;
      const list = groups[cc];
      const resi = list.filter((n) => n.residential).length;
      return `<section class="card">
        <header>
          <h2>${FLAG[cc] || '🌐'} ${esc(zh)} <span class="code">${esc(cc)}</span></h2>
          <div class="pills">
            <span class="pill">${list.length} 节点</span>
            <span class="pill resi">住宅 ${resi}</span>
            ${list.length - resi > 0 ? `<span class="pill dc">机房 ${list.length - resi}</span>` : ''}
            <span class="copy pill btn" data-copy="${esc(list.map((n) => n.vless || n.sstp).join('\n'))}">复制本组</span>
          </div>
        </header>
        ${renderNodeTable(list)}
      </section>`;
    })
    .join('');

  const failed = (data.failed || []).slice(0, 30)
    .map((f) => `<li><span class="mono">${esc(f.host)}:${esc(f.port || 443)}</span> — <span class="dim">${esc(f.error)}</span></li>`)
    .join('');

  const directPanel = renderDirectPanel(data);

  // 订阅面板：这是用户最常要复制的东西，放最上面、字号最大
  const subPanel = sub && sub.sub
    ? `<section class="subbox">
        <div class="subrow big">
          <span class="lab">订阅地址</span>
          <span class="val" title="${esc(sub.sub)}">${esc(sub.sub)}</span>
          <a class="open" href="${esc(sub.sub)}" target="_blank" rel="noreferrer">打开看原文</a>
          <span class="copy btn" data-copy="${esc(sub.sub)}">复制</span>
        </div>
        <div class="subrow">
          <span class="lab">Clash 版</span>
          <span class="val" title="${esc(sub.clash)}">${esc(sub.clash)}</span>
          <span class="copy btn" data-copy="${esc(sub.clash)}">复制</span>
        </div>
        <div class="subrow">
          <span class="lab">导入说明</span>
          <span class="hint">v2rayN：订阅分组 → 添加 → 粘贴上面的「订阅地址」。Clash Meta / Clash Verge：用「Clash 版」。
            <b>${nodes.length}</b> 条节点一次导入，每天自动换一批。</span>
          <span class="copy btn" data-copy="${esc(nodes.map((n) => n.vless).filter(Boolean).join('\n'))}">复制全部 vless</span>
        </div>
        <div class="subrow">
          <span class="lab">入口 / UUID</span>
          <span class="val small">${esc(sub.host || '')} · <span class="mono">${esc(sub.uuid || '')}</span></span>
        </div>
      </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>住宅 IP 节点订阅 · ip-auto</title>
<style>
  :root{
    --bg:#0b0f17; --panel:#121a26; --panel2:#0f1621; --line:#22303f;
    --text:#e6edf6; --dim:#8b9bb0; --acc:#4dd4ac; --acc2:#5b9cff; --warn:#ffb84d; --err:#ff6b6b;
  }
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 20% -10%,#16283c 0%,var(--bg) 55%);color:var(--text);
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1320px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:.5px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:22px}
  .sub .k{color:var(--acc)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
  .stat{background:linear-gradient(180deg,var(--panel) 0%,var(--panel2) 100%);border:1px solid var(--line);
        border-radius:14px;padding:14px 16px}
  .stat b{display:block;font-size:24px;letter-spacing:.5px}
  .stat span{color:var(--dim);font-size:12px}
  .stat.ok b{color:var(--acc)} .stat.r b{color:var(--acc2)} .stat.d b{color:var(--warn)}

  /* 订阅面板 */
  .subbox{background:linear-gradient(180deg,#12202e 0%,#0f1a26 100%);border:1px solid #24404f;
          border-radius:16px;padding:6px 18px;margin-bottom:22px;box-shadow:0 0 0 1px rgba(77,212,172,.06) inset}
  .subrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:11px 0;border-bottom:1px solid #1a2a36}
  .subrow:last-child{border-bottom:none}
  .subrow .lab{color:var(--dim);font-size:12px;min-width:88px;flex:0 0 auto}
  .subrow .val{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:#9fd7ff;
               background:#0a1420;border:1px solid #1b2d3d;padding:5px 10px;border-radius:8px;
               word-break:break-all;flex:1 1 320px;min-width:0}
  .subrow.big .val{font-size:14px;color:#bfe9ff;padding:8px 12px}
  .subrow .val.small{font-size:12px;color:var(--dim);flex:0 1 auto}
  .subrow .hint{flex:1 1 320px;color:var(--dim);font-size:12.5px}
  .subrow .hint b{color:var(--acc)}
  .open{font-size:12px;color:var(--acc);border:1px solid #1d4b3e;border-radius:8px;padding:4px 11px;
        text-decoration:none;white-space:nowrap}
  .open:hover{background:#132a23}

  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;margin-bottom:18px;overflow:hidden}
  .card header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;
               padding:15px 18px;border-bottom:1px solid var(--line);background:var(--panel2)}
  .card h2{margin:0;font-size:17px}
  .card h2 .code{color:var(--dim);font-size:12px;font-weight:400;margin-left:6px}
  .pills{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .pill{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
  .pill.resi{color:var(--acc);border-color:#1d4b3e} .pill.dc{color:var(--warn);border-color:#4b3d1d}
  .pill.btn{cursor:pointer;color:var(--acc2);border-color:#23384f}
  .pill.btn:hover{background:#16263a}
  table{width:100%;border-collapse:collapse}
  th,td{padding:9px 16px;text-align:left;border-bottom:1px solid #1a2432;font-size:13px;white-space:nowrap}
  th{color:var(--dim);font-weight:500;font-size:12px;letter-spacing:.4px}
  tbody tr:hover{background:#16202d}
  tbody tr:last-child td{border-bottom:none}
  td.nm{max-width:210px;overflow:hidden;text-overflow:ellipsis}
  td.org{max-width:230px;overflow:hidden;text-overflow:ellipsis}
  td.acts{text-align:right}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .dim{color:var(--dim)}
  .badge{font-size:11px;padding:1px 7px;border-radius:999px;margin-left:5px}
  .badge.resi{background:rgba(77,212,172,.13);color:var(--acc);border:1px solid rgba(77,212,172,.35)}
  .badge.dc{background:rgba(255,184,77,.12);color:var(--warn);border:1px solid rgba(255,184,77,.35)}
  .copy{cursor:pointer;font-size:12px;color:var(--acc2);border:1px solid #23384f;border-radius:8px;
        padding:2px 9px;margin-left:6px;display:inline-block}
  .copy:hover{background:#16263a}
  details{margin-top:8px}
  summary{cursor:pointer;color:var(--dim);font-size:13px}
  footer{margin-top:34px;color:var(--dim);font-size:12px;line-height:1.9}
  code.inline{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0d1520;padding:1px 6px;border-radius:6px;color:#9fd7ff}
  ul.plays{margin:10px 0 0;padding-left:20px;display:grid;gap:4px}
</style>
</head>
<body>
<div class="wrap">
  <h1>住宅 IP 节点订阅</h1>
  <div class="sub">
    生成时间 <span class="k">${esc(data.generated_at || '')}</span> ·
    数据源 <span class="k">${esc(data.source || '')}</span> ·
    探测耗时 <span class="k">${data.config?.probe_ms ? (data.config.probe_ms / 1000).toFixed(0) + 's' : '—'}</span>
  </div>

  <div class="stats">
    <div class="stat ok"><b>${s.success ?? nodes.length}</b><span>可用节点</span></div>
    <div class="stat r"><b>${s.residential ?? nodes.filter((n) => n.residential).length}</b><span>住宅出口</span></div>
    <div class="stat d"><b>${s.datacenter ?? 0}</b><span>机房出口</span></div>
    <div class="stat"><b>${s.countries ?? order.length}</b><span>国家/地区</span></div>
    ${Number.isFinite(s.worker_ms_median) ? `<div class="stat"><b>${Math.round(s.worker_ms_median)}<small style="font-size:13px;color:var(--dim)">ms</small></b><span>延迟中位数（最快 ${Math.round(s.worker_ms_min)}ms）</span></div>` : ''}
    <div class="stat"><b>${s.failed ?? 0}</b><span>探测失败</span></div>
  </div>

  ${subPanel}

  ${directPanel}

  ${cards || '<div class="card" style="padding:28px;text-align:center;color:var(--dim)">暂无可用节点</div>'}

  <details>
    <summary>失败的节点（${(data.failed || []).length}）</summary>
    <ul class="plays">${failed || '<li class="dim">无</li>'}</ul>
  </details>

  <footer>
    「入口」是客户端实际连的 Cloudflare 地址，<code class="inline">sni</code> 与 <code class="inline">host</code> 都会被改写成 Worker 域名，
    所以入口只是借一个能连通的 anycast IP；「真实住宅出口」才是最终出网的那台家宽机器。<br>
    节点每 24 小时自动换一批：GitHub Actions 每天 11:17（北京时间）+ 本机计划任务每天 09:30 各跑一轮，产物自动发布到本页。<br>
    本页由 <code class="inline">ip-auto</code> 生成，纯静态、无外部依赖。
  </footer>
</div>
<script>
document.addEventListener('click', function (e) {
  var el = e.target.closest('.copy');
  if (!el) return;
  var text = el.getAttribute('data-copy') || '';
  var old = el.textContent;
  var done = function () { el.textContent = '已复制'; setTimeout(function () { el.textContent = old; }, 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fb(text); done(); });
  } else { fb(text); done(); }
  function fb(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (err) {}
    document.body.removeChild(ta);
  }
});
</script>
</body>
</html>`;
}
