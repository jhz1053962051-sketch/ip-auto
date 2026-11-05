/**
 * 24 小时自动更新守护进程
 *
 * 每 N 小时跑一次 src/run.mjs（默认 24h，带随机抖动避免固定时刻被目标站识别）。
 * - 单实例：用锁文件防止重复运行
 * - 不重叠：上一轮没跑完不会开下一轮
 * - 全程只写 ./public 与 ./logs，不动系统里任何已有配置
 *
 * 用法：
 *   node scripts/schedule.mjs                    # 立即跑一轮，然后每 24h
 *   node scripts/schedule.mjs --every 6          # 每 6 小时
 *   node scripts/schedule.mjs --no-initial       # 不在启动时立刻跑
 *   node scripts/schedule.mjs --max 80 --concurrency 8
 *
 * 环境变量：
 *   IP_AUTO_INTERVAL_HOURS   间隔小时，默认 24
 *   IP_AUTO_JITTER_MIN       抖动上限（分钟），默认 20
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');
const LOCK = path.join(LOGS, 'schedule.lock');
const RUN = path.join(ROOT, 'src', 'run.mjs');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const INTERVAL_H = Number(args.every || process.env.IP_AUTO_INTERVAL_HOURS || 24);
const JITTER_MIN = Number(args.jitter || process.env.IP_AUTO_JITTER_MIN || 20);
const PASSTHRU = ['max', 'concurrency', 'timeout', 'countries', 'proxy', 'edges'];

fs.mkdirSync(LOGS, { recursive: true });

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const logLine = (msg) => {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOGS, 'schedule.log'), line + '\n', 'utf8');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 单实例锁 ---------------- */
if (fs.existsSync(LOCK)) {
  const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) {
    console.error(`[ip-auto] 已有守护进程在跑（pid ${pid}）。要重启请先结束它，或删除 ${LOCK}`);
    process.exit(1);
  }
  logLine(`清理陈旧锁（pid ${pid} 已不存在）`);
  fs.rmSync(LOCK, { force: true });
}
fs.writeFileSync(LOCK, String(process.pid), 'utf8');

let stopping = false;
const cleanup = () => {
  try { fs.rmSync(LOCK, { force: true }); } catch {}
};
process.on('SIGINT', () => { stopping = true; logLine('收到中断，退出'); cleanup(); process.exit(0); });
process.on('SIGTERM', () => { stopping = true; cleanup(); process.exit(0); });
process.on('exit', cleanup);

/* ---------------- 跑一轮 ---------------- */
function runOnce(round) {
  const cliArgs = [RUN];
  for (const k of PASSTHRU) if (args[k] !== undefined && args[k] !== true) cliArgs.push(`--${k}`, String(args[k]));

  return new Promise((resolve) => {
    const t0 = Date.now();
    logLine(`第 ${round} 轮开始: node ${cliArgs.slice(1).join(' ')}`);
    const child = spawn(process.execPath, cliArgs, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (buf) => {
      tail = (tail + buf.toString()).slice(-8000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => {
      logLine(`第 ${round} 轮启动失败: ${e.message}`);
      resolve({ ok: false, ms: Date.now() - t0 });
    });
    child.on('close', (code) => {
      const ms = Date.now() - t0;
      const line = tail.trim().split('\n').slice(-3).join(' | ');
      logLine(`第 ${round} 轮结束 code=${code} 耗时 ${(ms / 1000).toFixed(1)}s :: ${line}`);
      fs.writeFileSync(path.join(LOGS, `round-${round}.log`), tail, 'utf8');
      resolve({ ok: code === 0, ms });
    });
  });
}

/* ---------------- 主循环 ---------------- */
(async () => {
  logLine(`守护进程启动 pid=${process.pid} | 间隔 ${INTERVAL_H}h | 抖动 ±${JITTER_MIN}min`);
  let round = 1;
  let consecutiveFail = 0;

  if (!args['no-initial']) {
    const r = await runOnce(round++);
    consecutiveFail = r.ok ? 0 : 1;
  }

  while (!stopping) {
    const base = INTERVAL_H * 3600 * 1000;
    const jitter = (Math.random() * 2 - 1) * JITTER_MIN * 60 * 1000;
    // 连续失败时缩短等待，最多 1 小时后再试，避免整天没有一个可用节点
    const delay = consecutiveFail > 0 ? Math.min(base, 60 * 60 * 1000) : Math.max(base + jitter, 60 * 1000);

    const next = new Date(Date.now() + delay);
    logLine(`下一轮: ${next.toISOString().replace('T', ' ').slice(0, 19)}（${(delay / 3600000).toFixed(2)}h 后）`);

    // 分段睡眠，方便 Ctrl+C 立刻响应
    let left = delay;
    while (left > 0 && !stopping) {
      const step = Math.min(left, 5000);
      await sleep(step);
      left -= step;
    }
    if (stopping) break;

    const r = await runOnce(round++);
    consecutiveFail = r.ok ? 0 : consecutiveFail + 1;
  }

  cleanup();
})();
