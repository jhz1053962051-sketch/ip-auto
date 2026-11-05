/** @type {import('node:child_process')} */
/**
 * 24 小时自动更新：注册为 Windows 计划任务（不影响系统里已有的任何计划任务）
 *
 * 做的事：
 *   install  → 创建计划任务 ip-auto-daily（每天一次，用当前用户身份，登录时才跑）
 *   remove   → 删除该计划任务
 *   status   → 查看状态与下次运行时间
 *   run      → 立即跑一轮（等价于 node src/run.mjs）
 *
 * 为什么用计划任务而不是常驻守护进程：
 *   常驻进程要一直开着终端；计划任务由系统调度，重开机后照常触发，且能随时删干净。
 *   scripts/schedule.mjs 仍然保留，适合你想在终端里看着它跑的场景。
 *
 * 用法：
 *   node scripts/task.mjs install
 *   node scripts/task.mjs install --time 09:30
 *   node scripts/task.mjs status
 *   node scripts/task.mjs remove
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TASK = 'ip-auto-daily';
const NODE = process.execPath;
const RUNNER = path.join(ROOT, 'src', 'run.mjs');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'status';
const TIME = String(args.time || '09:30');

function schtasks(argv, opts = {}) {
  const buf = execFileSync('schtasks', argv, opts);
  // schtasks 在中文 Windows 上输出 GBK，直接按 utf8 解会乱码
  if (Buffer.isBuffer(buf)) {
    try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
  }
  return buf;
}

function install() {
  // 计划任务没有终端，重定向必须发生在 cmd 里。把整段逻辑放进一个 .cmd 包装脚本，
  // 再由 schtasks 直接指向它 —— 比在 /TR 里塞引号+重定向稳得多（实测后者会让任务返回 1）。
  const logsDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const wrapper = path.join(__dirname, 'run-task.cmd');
  const cmdBody = [
    '@echo off',
    'rem 计划任务入口：由 scripts/task.mjs 注册的 ip-auto-daily 调用',
    'setlocal',
    'chcp 65001 >nul',
    'cd /d "%~dp0.."',
    'if not exist "logs" mkdir "logs"',
    'echo. >> "logs\\task.log"',
    'echo ===== %date% %time% start ===== >> "logs\\task.log"',
    `"${NODE}" "${RUNNER}" >> "logs\\task.log" 2>&1`,
    'set RC=%ERRORLEVEL%',
    'echo ===== %date% %time% end rc=%RC% ===== >> "logs\\task.log"',
    'endlocal & exit /b %RC%',
    '',
  ].join('\r\n');
  fs.writeFileSync(wrapper, cmdBody, 'utf8');

  // /F 覆盖同名任务 —— 只覆盖我们自己名字的任务，不碰其它
  schtasks([
    '/Create',
    '/TN', TASK,
    '/TR', wrapper,
    '/SC', 'DAILY',
    '/ST', TIME,
    '/F',
  ]);
  console.log(`已创建计划任务 ${TASK}，每天 ${TIME} 运行`);
  console.log(`  入口: ${wrapper}`);
  console.log(`  日志: ${path.join(logsDir, 'task.log')}`);
  console.log(`  取消: node scripts/task.mjs remove`);
}

function remove() {
  try {
    schtasks(['/Delete', '/TN', TASK, '/F']);
    console.log(`已删除计划任务 ${TASK}`);
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/cannot find|找不到|ERROR: The system cannot find/.test(msg)) {
      console.log(`计划任务 ${TASK} 不存在，无需删除`);
    } else {
      throw e;
    }
  }
}

function status() {
  try {
    const out = schtasks(['/Query', '/TN', TASK, '/FO', 'LIST', '/V']);
    // 只挑几行关键信息，避免整页英文输出
    const keep = out.split(/\r?\n/).filter((l) =>
      /TaskName|Status|Next Run|Last Run|Last Result|Task To Run|Scheduled Task State|下次运行|状态|上次运行|上次结果|要运行的任务/i.test(l));
    console.log(keep.length ? keep.join('\n') : out.slice(0, 1200));
  } catch {
    console.log(`计划任务 ${TASK} 未注册。运行 node scripts/task.mjs install 创建。`);
  }
}

if (process.platform !== 'win32') {
  console.error('这个脚本只处理 Windows 计划任务。其它系统请用 cron 或 scripts/schedule.mjs。');
  process.exit(1);
}

switch (cmd) {
  case 'install': install(); break;
  case 'remove': remove(); break;
  case 'status': status(); break;
  default:
    console.error(`未知命令: ${cmd}（可用: install / remove / status）`);
    process.exit(1);
}
