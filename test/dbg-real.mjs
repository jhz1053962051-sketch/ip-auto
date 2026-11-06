// 直接验证 src/realmeas.mjs（新：进程内 socks5 探针 + 出口国家校验）
import fs from 'node:fs';
import path from 'node:path';
import { measureReal } from '../src/realmeas.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const nodes = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8')).vless_nodes;
// 传对象而不是字符串：measureReal 会用 n.real（节点真身 host:port）作为结果 key，
// 传字符串时只能退化成 CF 边缘地址（104.26.x.x:443），一堆节点重名，回填会错位。
const vless = nodes.map((n) => ({ vless: n.vless, real: n.real, name: n.name }));
const limit = Number(process.argv[2] || 4);
const t0 = Date.now();
const r = await measureReal(vless.slice(0, limit), {
  root: ROOT,
  bin: path.join(ROOT, 'tools/xray.exe'),
  basePort: 13100,
  concurrency: 3,
  timeoutMs: 25,
  startupMs: 1800,
  log: (l) => console.log(l),
});
console.log('---');
console.log(JSON.stringify({ total: r.total, matched: r.matched, median: r.median, min: r.min, elapsed: Date.now() - t0 }, null, 0));
for (const f of r.flat) console.log(`${f.name.padEnd(16)} ${f.real_ms === null ? 'FAIL ' + f.real_error : f.real_ms + 'ms'} ${f.real_loc} ${f.real_ip} ${f.real_colo}`);
fs.writeFileSync(path.join(ROOT, process.argv[3] || 'logs/real2.json'), JSON.stringify({ generated_at: new Date().toISOString(), ...r }, null, 1), 'utf8');
process.exit(0);