/**
 * 本地站点渲染：把一个 data.json 渲染成自包含的 index.html
 * （无外部资源、无 CDN 依赖，双击即可看；同时可直接放到 GitHub Pages）
 */
import { COUNTRY_ZH } from './edges.mjs';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtMs = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '—');

export function renderIndexHtml(data) {
  const s = data.stats || {};
  const countries = Object.values(data.countries || {}).sort((a, b) => (b.count || 0) - (a.count || 0));
  const resiTotal = s.residential || 0;
  const dcTotal = s.datacenter || 0;

  const cards = countries
    .map((g) => {
      const code = String(g.code || '??').toUpperCase();
      const zh = COUNTRY_ZH[code] || g.name || code;
      const rows = (g.nodes || [])
        .slice()
        .sort((a, b) => {
          const ra = a.residential === 'residential' ? 0 : 1;
          const rb = b.residential === 'residential' ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return (a.latency_ms || 1e9) - (b.latency_ms || 1e9);
        })
        .map((n) => {
          const isResi = n.residential === 'residential';
          return `<tr>
            <td class="mono">${esc(n.host)}:${esc(n.port)}</td>
            <td><span class="badge ${isResi ? 'resi' : 'dc'}">${isResi ? '住宅' : '机房'}</span></td>
            <td class="mono">${esc(n.exit_ip || '—')}</td>
            <td class="mono dim">${esc(n.org || '—')}</td>
            <td class="mono">${fmtMs(n.latency_ms)}</td>
            <td><code class="copy" data-copy="${esc(`sstp://vpn:vpn@${n.host}:${n.port}`)}">复制</code></td>
          </tr>`;
        })
        .join('');
      return `<section class="card">
        <header>
          <h2>${esc(zh)} <span class="code">${esc(code)}</span></h2>
          <div class="pills">
            <span class="pill">${g.count} 节点</span>
            <span class="pill resi">住宅 ${g.residential}</span>
            <span class="pill dc">机房 ${g.datacenter}</span>
          </div>
        </header>
        <table>
          <thead><tr><th>入口</th><th>类型</th><th>出口 IP</th><th>ASN / 组织</th><th>延迟</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
    })
    .join('');

  const failed = (data.failed || []).slice(0, 30)
    .map((f) => `<li><span class="mono">${esc(f.host)}:${esc(f.port || 443)}</span> — <span class="dim">${esc(f.error)}</span></li>`)
    .join('');

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
  .wrap{max-width:1180px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:.5px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:24px}
  .sub .k{color:var(--acc)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:26px}
  .stat{background:linear-gradient(180deg,var(--panel) 0%,var(--panel2) 100%);border:1px solid var(--line);
        border-radius:14px;padding:14px 16px}
  .stat b{display:block;font-size:24px;letter-spacing:.5px}
  .stat span{color:var(--dim);font-size:12px}
  .stat.ok b{color:var(--acc)} .stat.r b{color:var(--acc2)} .stat.d b{color:var(--warn)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;margin-bottom:18px;overflow:hidden}
  .card header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;
               padding:16px 18px;border-bottom:1px solid var(--line);background:var(--panel2)}
  .card h2{margin:0;font-size:17px}
  .card h2 .code{color:var(--dim);font-size:12px;font-weight:400;margin-left:6px}
  .pills{display:flex;gap:8px;flex-wrap:wrap}
  .pill{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
  .pill.resi{color:var(--acc);border-color:#1d4b3e} .pill.dc{color:var(--warn);border-color:#4b3d1d}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px 18px;text-align:left;border-bottom:1px solid #1a2432;font-size:13px;white-space:nowrap}
  th{color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.6px}
  tbody tr:hover{background:#16202d}
  tbody tr:last-child td{border-bottom:none}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .dim{color:var(--dim)}
  .badge{font-size:11px;padding:2px 8px;border-radius:999px}
  .badge.resi{background:rgba(77,212,172,.13);color:var(--acc);border:1px solid rgba(77,212,172,.35)}
  .badge.dc{background:rgba(255,184,77,.12);color:var(--warn);border:1px solid rgba(255,184,77,.35)}
  .copy{cursor:pointer;font-size:12px;color:var(--acc2);border:1px solid #23384f;border-radius:8px;padding:2px 9px}
  .copy:hover{background:#16263a}
  details{margin-top:8px}
  summary{cursor:pointer;color:var(--dim);font-size:13px}
  footer{margin-top:34px;color:var(--dim);font-size:12px;line-height:1.9}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0d1520;padding:1px 6px;border-radius:6px;color:#9fd7ff}
  ul.plays{margin:10px 0 0;padding-left:20px;display:grid;gap:4px}
</style>
</head>
<body>
<div class="wrap">
  <h1>住宅 IP 节点订阅</h1>
  <div class="sub">
    生成时间 <span class="k">${esc(data.generated_at || '')}</span> ·
    数据源 <span class="k">${esc(data.source || '')}</span> ·
    代理 <span class="k">${esc(data.config?.proxy || '本机')}</span>
  </div>

  <div class="stats">
    <div class="stat ok"><b>${s.success ?? 0}</b><span>可用节点</span></div>
    <div class="stat r"><b>${resiTotal}</b><span>住宅出口</span></div>
    <div class="stat d"><b>${dcTotal}</b><span>机房出口</span></div>
    <div class="stat"><b>${s.countries ?? 0}</b><span>国家/地区</span></div>
    <div class="stat"><b>${s.failed ?? 0}</b><span>探测失败</span></div>
    <div class="stat"><b>${data.config?.probe_ms ? (data.config.probe_ms / 1000).toFixed(0) + 's' : '—'}</b><span>探测耗时</span></div>
  </div>

  ${cards || '<div class="card" style="padding:28px;text-align:center;color:var(--dim)">暂无可用节点</div>'}

  <details>
    <summary>失败的节点（${(data.failed || []).length}）</summary>
    <ul class="plays">${failed || '<li class="dim">无</li>'}</ul>
  </details>

  <footer>
    订阅用法：把 <code>nodes.txt</code> 的网址填进 edgetunnel 后台「自定义优选IP」框，一次配置长期自动更新。<br>
    本页由 <code>ip-auto</code> 本地流水线生成，纯静态、无外部依赖。
  </footer>
</div>
<script>
document.addEventListener('click', function (e) {
  var el = e.target.closest('.copy');
  if (!el) return;
  var text = el.getAttribute('data-copy') || '';
  var done = function () { var old = el.textContent; el.textContent = '已复制'; setTimeout(function(){ el.textContent = old; }, 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function(){ fallback(text); done(); });
  } else { fallback(text); done(); }
  function fallback(t) {
    var ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (err) {}
    document.body.removeChild(ta);
  }
});
</script>
</body>
</html>`;
}
