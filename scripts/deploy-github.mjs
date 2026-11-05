/**
 * GitHub 一键部署（纯 API，不碰浏览器、不碰你已有的仓库）
 *
 * 做的事（全部幂等）：
 *   1. 校验 Token、拿到用户名
 *   2. 创建（或复用）仓库 <prefix>，推上本项目代码
 *   3. 打开 Actions 权限（workflow 默认权限、允许 Actions 创建 PR 提交）
 *   4. 建立 GitHub Pages（Source = GitHub Actions）
 *   5. 写 repository variable NODES_URL（页面展示用）
 *   6. 触发第一次 workflow，轮询到跑完，打印产物地址
 *
 * 不会删除、不会改名、不会动你已有的任何仓库。
 *
 * 用法：
 *   export GH_TOKEN=ghp_xxxx
 *   node scripts/deploy-github.mjs --dry-run
 *   node scripts/deploy-github.mjs --repo ip-auto --private
 *
 * 参数：
 *   --token <t>       GitHub Token（默认 GH_TOKEN）
 *   --repo <name>     仓库名，默认 ip-auto
 *   --private          建成私有仓库（默认公开；Pages 公开仓库免审）
 *   --no-run           不触发 workflow
 *   --dry-run          只看会做什么
 *
 * Token 需要 scopes：repo（或 fine-grained 的 Contents:write + Workflows:write +
 * Administration:write + Pages:write + Actions:write）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.github.com';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { out[k] = v; i++; }
    else out[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const TOKEN = String(args.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const DRY = Boolean(args['dry-run'] || args.dryRun);
const REPO = String(args.repo || 'ip-auto');
const PRIVATE = Boolean(args.private);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] !`, ...a);

if (!TOKEN) {
  console.error('缺少 Token。到 https://github.com/settings/tokens 创建（勾 repo + workflow），然后：');
  console.error('  export GH_TOKEN=ghp_xxxx');
  process.exit(1);
}

async function gh(method, endpoint, body) {
  const url = endpoint.startsWith('http') ? endpoint : API + endpoint;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ip-auto-deploy',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 300);
    const err = new Error(`${method} ${endpoint} → HTTP ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** 让 git 用 Token 走一次 HTTPS（不写全局配置，只在这一条命令里注入） */
function git(args, { auth = false } = {}) {
  const full = auth
    ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`, ...args]
    : args;
  return execFileSync('git', full, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const FILES_TO_PUSH = [
  'src', 'scripts', 'cloudflare', 'public', 'package.json', 'README.md', '.github', '.gitignore',
];

(async () => {
  log('===== GitHub 部署开始 =====');
  log(`模式: ${DRY ? 'DRY-RUN（不做改动）' : '实际部署'}`);
  log(`仓库: ${REPO}（${PRIVATE ? '私有' : '公开'}）`);

  /* 1) 校验 token */
  const me = await gh('GET', '/user');
  const OWNER = me.login;
  log(`Token 有效: ${OWNER}`);

  /* 2) 仓库 */
  let repo = null;
  try {
    repo = await gh('GET', `/repos/${OWNER}/${REPO}`);
    log(`复用已有仓库: ${repo.full_name}（${repo.private ? '私有' : '公开'}）`);
  } catch (e) {
    if (e.status !== 404) throw e;
    if (DRY) {
      warn(`将创建仓库: ${OWNER}/${REPO}`);
    } else {
      repo = await gh('POST', '/user/repos', {
        name: REPO,
        description: 'VPN Gate SSTP 住宅节点自动采集 / 检测 / 订阅（Cloudflare + GitHub Actions 24h 全自动）',
        private: PRIVATE,
        has_issues: true,
        has_wiki: false,
        auto_init: false,
      });
      log(`已创建仓库: ${repo.full_name}`);
    }
  }
  const branch = repo?.default_branch || 'main';

  /* 3) 推代码 */
  if (DRY) {
    warn(`将推送 ${FILES_TO_PUSH.join(', ')} 到 ${OWNER}/${REPO}@${branch}`);
  } else {
    // 本地先建一个隔离的 git 目录，不动用户任何已有 .git
    const hasGit = fs.existsSync(path.join(ROOT, '.git'));
    if (!hasGit) git(['init', '-b', branch]);
    git(['add', ...FILES_TO_PUSH.filter((f) => fs.existsSync(path.join(ROOT, f)))]);
    try {
      git(['-c', 'user.name=ip-auto', '-c', 'user.email=ip-auto@local', 'commit', '-m', 'chore: 初始化住宅节点订阅流水线']);
      log('已创建初始化提交');
    } catch (e) {
      if (!/nothing to commit|no changes added/.test(String(e.stderr || e.message))) throw e;
      log('工作区无变化，跳过提交');
    }
    const remote = `https://github.com/${OWNER}/${REPO}.git`;
    const remotes = git(['remote']).split('\n').map((s) => s.trim());
    if (remotes.includes('origin')) git(['remote', 'set-url', 'origin', remote]);
    else git(['remote', 'add', 'origin', remote]);
    git(['push', '-u', 'origin', branch, '--force-with-lease'], { auth: true });
    log(`已推送分支 ${branch}`);
  }

  /* 4) Actions 权限：允许 workflow 写仓库 + 允许 Actions 创建 PR 提交 */
  if (!DRY) {
    for (const [label, endpoint, body] of [
      ['workflow 默认权限', `/repos/${OWNER}/${REPO}/actions/permissions/workflow`, {
        default_workflow_permissions: 'write',
        can_approve_pull_request_reviews: true,
      }],
      ['启用 Actions', `/repos/${OWNER}/${REPO}/actions/permissions`, { enabled: true, allowed_actions: 'all' }],
    ]) {
      try {
        await gh('PUT', endpoint, body);
        log(`${label}: 已设置`);
      } catch (e) {
        warn(`${label} 设置失败（可能需手动在 Settings → Actions 打开）: ${e.message}`);
      }
    }
  }

  /* 5) Pages（Source = GitHub Actions） */
  if (!DRY) {
    try {
      await gh('POST', `/repos/${OWNER}/${REPO}/pages`, { build_type: 'workflow' });
      log('Pages: 已启用（Source = GitHub Actions）');
    } catch (e) {
      if (e.status === 409) {
        try {
          await gh('PUT', `/repos/${OWNER}/${REPO}/pages`, { build_type: 'workflow' });
          log('Pages: 已切换为 GitHub Actions 源');
        } catch (e2) {
          warn(`Pages 切换失败: ${e2.message}`);
        }
      } else {
        warn(`Pages 启用失败（可在 Settings → Pages 手动选 GitHub Actions）: ${e.message}`);
      }
    }
  }

  const pagesUrl = `https://${OWNER.toLowerCase()}.github.io/${REPO}`;
  const nodesUrl = `${pagesUrl}/nodes.txt`;

  /* 6) 仓库变量（页面展示用） */
  if (!DRY) {
    try {
      await gh('POST', `/repos/${OWNER}/${REPO}/actions/variables`, { name: 'NODES_URL', value: nodesUrl });
      log(`变量 NODES_URL = ${nodesUrl}`);
    } catch (e) {
      if (e.status === 409) log('变量 NODES_URL 已存在，跳过');
      else warn(`写变量失败: ${e.message}`);
    }
  }

  /* 7) 触发 workflow 并等待 */
  if (!DRY && !args['no-run']) {
    try {
      await gh('POST', `/repos/${OWNER}/${REPO}/actions/workflows/vpngate.yml/dispatches`, { ref: branch });
      log('已触发 workflow: VPN Gate 住宅节点采集');
      log('轮询运行状态（最多 8 分钟）…');
      const deadline = Date.now() + 8 * 60 * 1000;
      let runId = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10000));
        const runs = await gh('GET', `/repos/${OWNER}/${REPO}/actions/workflows/vpngate.yml/runs?per_page=1`);
        const run = runs?.workflow_runs?.[0];
        if (!run) continue;
        if (run.id !== runId) { runId = run.id; log(`运行 #${run.run_number} 已排队: ${run.html_url}`); }
        if (run.status === 'completed') {
          log(`运行结束: ${run.conclusion}（${run.html_url}）`);
          if (run.conclusion !== 'success') {
            warn('首轮未成功。可看日志排查，或手动在 Actions 页面 Run workflow 再试。');
          }
          break;
        }
        log(`  …${run.status}`);
      }
    } catch (e) {
      warn(`触发 workflow 失败（可在 Actions 页面手动 Run workflow）: ${e.message}`);
    }
  }

  const out = {
    owner: OWNER,
    repo: REPO,
    branch,
    repo_url: `https://github.com/${OWNER}/${REPO}`,
    actions_url: `https://github.com/${OWNER}/${REPO}/actions`,
    pages_url: pagesUrl,
    nodes_url: nodesUrl,
    data_url: `${pagesUrl}/data.json`,
  };
  const outFile = path.join(ROOT, 'logs', 'github-deploy.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  log('===== 部署结果 =====');
  log(`仓库     ${out.repo_url}`);
  log(`Actions  ${out.actions_url}`);
  log(`站点     ${out.pages_url}`);
  log(`订阅     ${out.nodes_url}`);
  log(`结果已写入 ${outFile}`);
})().catch((e) => {
  console.error(`\n部署失败: ${e.message}`);
  if (e.status === 401) console.error('提示：Token 无效或已过期。');
  if (e.status === 403) console.error('提示：Token 权限不足（需要 repo + workflow）；或对已存在仓库无 push 权限。');
  process.exit(1);
});
