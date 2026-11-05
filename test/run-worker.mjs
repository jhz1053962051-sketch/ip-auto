/**
 * Cloudflare Worker 本地验证 harness
 *
 * 把 cloudflare/check-worker.js 里对 `cloudflare:sockets` 的 import 换成
 * test/mock-sockets.mjs（Node 版真实网络实现），然后直接调 worker.fetch()。
 * 这样能在不部署的情况下验证 Worker 里的 SSTP 握手代码是否真的可用。
 *
 * 用法：
 *   node test/run-worker.mjs vpn492686662.opengw.net 1591
 *   node test/run-worker.mjs public-vpn-129.opengw.net 443
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'cloudflare', 'check-worker.js');
const OUT = path.join(__dirname, '.worker-under-test.mjs');

let code = fs.readFileSync(SRC, 'utf8');
const before = code;
code = code.replace(
  /import\s*\{\s*connect\s*\}\s*from\s*['"]cloudflare:sockets['"];?/,
  "import { connect } from './mock-sockets.mjs';",
);
if (code === before) {
  console.error('未能在 worker 里找到 `import { connect } from \'cloudflare:sockets\'`，无法注入替身');
  process.exit(1);
}
fs.writeFileSync(OUT, code, 'utf8');

const mod = await import(pathToFileURL(OUT).href);
const worker = mod.default;

const [host, port] = [process.argv[2], process.argv[3] || '443'];
if (!host) {
  console.error('用法: node test/run-worker.mjs <host> [port]');
  process.exit(1);
}

// 构造一个最小的 Request（Node 18+ 自带全局 Request/Response）
const url = `https://worker.test/check?sstp=vpn:vpn@${host}:${port}`;
const req = new Request(url, { method: 'GET' });

// Workers 里 request.cf.colo 由平台注入，这里手动补上
Object.defineProperty(req, 'cf', { value: { colo: 'LOCAL' }, enumerable: true });

const t0 = Date.now();
const res = await worker.fetch(req, {}, {});
const text = await res.text();
console.log(`HTTP ${res.status}  ${Date.now() - t0}ms`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 1));
} catch {
  console.log(text.slice(0, 2000));
}

fs.rmSync(OUT, { force: true });
