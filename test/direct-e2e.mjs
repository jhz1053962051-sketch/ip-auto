/**
 * 真实浏览器级验证：直连代理是不是真的能出网、出口在哪、延迟多少。
 *
 * 为什么要单独一个脚本：
 *   `checkProxy` 测的是「CONNECT cloudflare.com:443 → /cdn-cgi/trace」，
 *   只能说明 TLS 能起来、trace 能读到，**不代表能正常访问任意 HTTPS 站点**。
 *   有的代理只放行白名单域名，或者对非 443 端口封堵。
 *   这里用 curl 经每个代理实际访问三个不同站点，拿真实 http_code + ttfb。
 *
 * 用法：node test/direct-e2e.mjs [--nodes public/direct/nodes.txt] [--limit 0]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const NODES = arg('nodes', 'public/direct/nodes.txt');
const LIMIT = Number(arg('limit', '0'));

const lines = fs.readFileSync(NODES, 'utf8').split('\n')
  .map((l) => /^\s*\d+\.\s+(\w+)\s*\|\s*(\w+)\s*\|\s*(\S+)\s*\|\s*([\d.]+):(\d+)/.exec(l))
  .filter(Boolean)
  .map((m) => ({ cc: m[1], proto: m[2], kind: m[3], host: m[4], port: m[5] }));

const targets = LIMIT > 0 ? lines.slice(0, LIMIT) : lines;
const URLS = ['https://www.gstatic.com/generate_204', 'https://api.ipify.org/?format=json', 'https://www.youtube.com/'];

console.log(`用 curl 经 ${targets.length} 个直连代理访问 3 个站点\n`);

for (const n of targets) {
  const px = `http://${n.host}:${n.port}`;
  const row = [];
  for (const u of URLS) {
    try {
      const out = execFileSync('curl', [
        '-sS', '--max-time', '25', '-x', px, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '-w', '%{http_code} %{time_total} %{time_starttransfer}',
        u,
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const [code, total, ttfb] = out.split(/\s+/);
      row.push(`${code}(${Number(ttfb).toFixed(2)}s)`);
    } catch (e) {
      const msg = String(e.stderr || e.message || '').replace(/\s+/g, ' ').slice(0, 40);
      row.push(`ERR(${msg})`);
    }
  }
  console.log(`${n.cc} ${n.kind} ${n.host}:${n.port}`);
  console.log(`   gstatic ${row[0]} | ipify ${row[1]} | youtube ${row[2]}`);
}
