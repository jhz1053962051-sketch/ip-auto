/**
 * 本地静态服务：把 ./public 挂到 http://127.0.0.1:8080
 *
 * 用途：
 *   - 本地预览 index.html（节点概览页）
 *   - 把 nodes.txt 暴露成本机 HTTP 地址，喂给 edgetunnel 的「自定义优选IP」
 *     （仅在本机能访问时有用；真正给客户端订阅请用 GitHub Pages 地址）
 *
 * 用法：
 *   node scripts/serve.mjs
 *   node scripts/serve.mjs --port 8080 --host 127.0.0.1
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.IP_AUTO_SERVE_PORT || 8080);
const HOST = args.host || process.env.IP_AUTO_SERVE_HOST || '127.0.0.1';
const DIR = path.resolve(ROOT, args.dir || 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // 防目录穿越：规范化后必须仍在 DIR 内
  const abs = path.resolve(DIR, '.' + rel);
  if (!abs.startsWith(DIR + path.sep) && abs !== DIR) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 ${rel}\n先跑一次 node src/run.mjs 生成产物`);
    return;
  }

  const body = fs.readFileSync(abs);
  res.writeHead(200, {
    'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`[ip-auto] 静态站点 http://${HOST}:${PORT}`);
  console.log(`[ip-auto]   概览页   http://${HOST}:${PORT}/`);
  console.log(`[ip-auto]   节点订阅 http://${HOST}:${PORT}/nodes.txt`);
  console.log(`[ip-auto]   数据     http://${HOST}:${PORT}/data.json`);
  console.log(`[ip-auto] 根目录 ${DIR}`);
});
