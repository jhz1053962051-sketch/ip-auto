#!/usr/bin/env node
/**
 * ⚠️ 已废弃（2026-11-06）。
 *
 * 这个脚本是"每节点独立 Xray 进程 + curl 测 TTFB"的老实现，**curl 那一步是错的**：
 * 本环境的 `curl.exe` 会被外层拦截层接管、静默忽略 `--socks5-hostname`
 * （拿端口 9 当 socks 代理也返回 200），量到的其实是拦截层那条路。
 *
 * 现在统一走：
 *   1) `src/realmeas.mjs` —— 进程内 SOCKS5（`src/socksprobe.mjs`）+ 出口国家校验
 *   2) `node scripts/apply-measured.mjs --in logs/real2.json --drop-failed` 回填并重渲染
 * 或者干脆跑完整流水线 `node src/run.mjs`（7.5 段会自动实测）。
 *
 * 本文件保留只是为了不打断可能存在的旧调用：它会把参数转给新实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureReal } from '../src/realmeas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
  }
  return out;
}
const args = argsOf(process.argv.slice(2));
const DATA = path.resolve(ROOT, args.data || 'public/data.json');
const OUT = path.resolve(ROOT, args.out || 'logs/real2.json');

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const nodes = (data.vless_nodes || []).map((v) => ({ vless: v.vless, real: v.real, name: v.name }));
const limit = Number(args.limit || 0);
const use = limit > 0 ? nodes.slice(0, limit) : nodes;

console.log(`[measure] 改用进程内 SOCKS5 实测 ${use.length} 个节点（curl 已弃用）`);
const r = await measureReal(use, {
  root: ROOT,
  bin: path.join(ROOT, 'tools', process.platform === 'win32' ? 'xray.exe' : 'xray'),
  basePort: Number(args['base-port'] || 12000),
  concurrency: Number(args.concurrency || 3),
  timeoutMs: Number(args.timeout || 20),
  startupMs: Number(args.startup || 2000),
  log: (l) => console.log(l),
});
fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), ...r }, null, 1), 'utf8');
console.log(`[measure] 可测 ${r.matched}/${r.total}，中位 ${r.median}ms，最快 ${r.min}ms → ${OUT}`);
console.log('[measure] 回填：node scripts/apply-measured.mjs --in ' + path.relative(ROOT, OUT) + ' --drop-failed');
process.exit(0);