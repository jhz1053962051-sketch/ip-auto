#!/usr/bin/env node
// 把本机产物推到 GitHub（让 Pages 上显示 real_ms 实测延迟）。
//
// 为什么需要这个：GitHub Actions 跑在美区、没有 tools/xray.exe，
// 只能出 worker_ms（Worker 到节点那一段，不含「浏览器→CF colo」，
// 与本机实测的 Spearman 相关系数只有 0.075 —— 基本是两把不相干的尺子）。
// 真正有参考价值的 real_ms 只有本机测得出来，所以由本机计划任务负责发布。
//
// 冲突策略：Actions 每 11:17 也会推产物，两边撞上时以本机为准
// （本机有 real_ms，信息更多），但**不 force push**：先 fetch，
// 被拒就 reset 到最新 main 再把本地产物覆盖回去重建提交。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function arg(name, dflt = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);
const say = (m) => console.log(`[publish] ${m}`);

function readToken() {
  if (process.env.IP_AUTO_GH_TOKEN) return process.env.IP_AUTO_GH_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  for (const f of ['logs/gh-token', 'logs/gh-token.txt', '.gh-token']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    }
  }
  return '';
}

const TOKEN = readToken();
if (!TOKEN) {
  say('没有 GitHub token（IP_AUTO_GH_TOKEN 环境变量，或 logs/gh-token 文件）');
  process.exit(2);
}

const BRANCH = arg('branch', 'main');
const MSG = arg('message', '') || `chore: 本机实测产物 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const DRY = flag('dry-run');

// 只在这几条命令上注入凭据，不写任何全局/仓库配置
const AUTH = 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
function git(args, opts = {}) {
  return execFileSync('git', ['-c', `http.https://github.com/.extraheader=${AUTH}`, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, https_proxy: process.env.IP_AUTO_PUSH_PROXY || 'http://127.0.0.1:7897' },
  }).trim();
}
function gitTry(args) {
  try {
    return { ok: true, out: git(args) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`.trim() };
  }
}

// 1) 有没有东西要提交
git(['add', 'public', 'logs/latest.json']);
const staged = gitTry(['diff', '--staged', '--quiet']);
// diff --quiet 有差异时返回 1（被 gitTry 当成失败），这里反过来看
if (staged.ok) {
  say('产物没有变化，不用推');
  process.exit(0);
}

if (DRY) {
  say(`--dry-run：会提交 ${git(['diff', '--staged', '--name-only']).split('\n').length} 个文件`);
  process.exit(0);
}

// 2) 首次提交 + 推送
const commit = gitTry(['commit', '-m', MSG]);
if (!commit.ok && !/nothing to commit|no changes added/i.test(commit.out)) {
  say(`提交失败：${commit.out.split('\n')[0]}`);
  process.exit(1);
}

// 推完还要让 Pages 真正发布：vpngate.yml 会重新采集并覆盖 public/，
// 所以只能调 deploy-pages.yml（它只做「把仓库现有 public/ 发上去」）。
function dispatchDeploy() {
  const [owner, repo] = (process.env.IP_AUTO_REPO || 'jhz1053962051-sketch/ip-auto').split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/deploy-pages.yml/dispatches`;
  // 注意：不能用 `-o /dev/null` —— Windows 上 curl 是原生程序，/dev/null 不是合法路径，
  // 会以 exit 23（write error）失败，即使请求本身已经成功返回 204。
  let code = '';
  try {
    code = execFileSync('curl', [
      '-sS', '--fail', '--max-time', '30',
      '-X', 'POST', url,
      '-H', `Authorization: Bearer ${TOKEN}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
      '-H', 'User-Agent: ip-auto-publish',
      '-d', JSON.stringify({ ref: BRANCH }),
    ], {
      encoding: 'utf8',
      env: { ...process.env, https_proxy: process.env.IP_AUTO_PUSH_PROXY || 'http://127.0.0.1:7897' },
    }).trim();
    // --fail 让 HTTP >=400 变成非零退出；能走到这里就是 204（成功受理，响应体为空）
    say('已触发 Pages 发布（deploy-pages.yml）');
    return;
  } catch (e) {
    code = `${e?.stdout || ''}${e?.stderr || ''}`.trim() || `exit ${e?.status}`;
  }
  say(`触发 Pages 发布失败：${code.slice(0, 120)}（不影响产物，可手动跑 deploy-pages.yml）`);
}

let pushed = gitTry(['push', 'origin', `HEAD:${BRANCH}`]);
if (pushed.ok) {
  say('推送成功');
  dispatchDeploy();
  process.exit(0);
}

// 3) 被拒（Actions 刚推过）→ 快照本地产物，reset 到最新 main，覆盖回来再提交
say(`推送被拒，改为在最新 ${BRANCH} 之上重建提交`);
if (/stale info|fetch first|non-fast-forward|rejected/i.test(pushed.out)) {
  const snap = path.join(ROOT, 'logs', 'publish-snap');
  fs.rmSync(snap, { recursive: true, force: true });
  fs.mkdirSync(snap, { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(snap, 'public'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'logs', 'latest.json'))) {
    fs.copyFileSync(path.join(ROOT, 'logs', 'latest.json'), path.join(snap, 'latest.json'));
  }

  const f = gitTry(['fetch', 'origin', BRANCH]);
  if (!f.ok) {
    say(`fetch 失败：${f.out.split('\n')[0]}`);
    process.exit(1);
  }
  gitTry(['reset', '--hard', `origin/${BRANCH}`]);
  fs.rmSync(path.join(ROOT, 'public'), { recursive: true, force: true });
  fs.cpSync(path.join(snap, 'public'), path.join(ROOT, 'public'), { recursive: true });
  if (fs.existsSync(path.join(snap, 'latest.json'))) {
    fs.copyFileSync(path.join(snap, 'latest.json'), path.join(ROOT, 'logs', 'latest.json'));
  }
  git(['add', 'public', 'logs/latest.json']);
  const c2 = gitTry(['commit', '-m', MSG]);
  if (!c2.ok && !/nothing to commit|no changes added/i.test(c2.out)) {
    say(`重建提交失败：${c2.out.split('\n')[0]}`);
    process.exit(1);
  }
  pushed = gitTry(['push', 'origin', `HEAD:${BRANCH}`]);
  if (pushed.ok) {
    say('重建后推送成功');
    dispatchDeploy();
    process.exit(0);
  }
}

say(`推送失败：${pushed.out.split('\n').slice(0, 3).join(' | ')}`);
process.exit(1);
