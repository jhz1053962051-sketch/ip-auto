/**
 * 把 edgetunnel 以「Pages Functions 高级模式」（_worker.js）方式部署到 Cloudflare Pages。
 *
 * 为什么需要这一步：
 *   本网络对 *.workers.dev 做了 SNI 级阻断（TLS 握手直接 ECONNRESET），
 *   而 *.pages.dev 可以正常访问。把同一个 _worker.js 放到 Pages 上，
 *   就能用一个不被阻断的域名跑完全相同的逻辑，客户端无需任何前置代理。
 *
 * 为什么用 wrangler 而不是裸调上传 API：
 *   Pages 的 `POST /pages/projects/{p}/deployments` 直传（manifest + 按 hash 命名的文件）
 *   在实测中能被服务端接受（stage=deploy=success），但 Functions 并未真正生效——
 *   访问任何路径都返回空体 404。换成 `wrangler pages deploy` 上传同样的 _worker.js
 *   立刻正常（/version、/login、/sub 全通）。差别在于 wrangler 会先做一次 bundle
 *   并带上 `_routes.json`/functions 元数据，裸 API 直传缺了这部分。故这里只保留
 *   「建项目 + 写绑定」，上传交给 wrangler。
 *
 * 用法:
 *   CF_API_TOKEN=xxx node scripts/deploy-pages-edge.mjs [--project NAME] [--dry-run]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { httpRequest, parseProxy } from '../src/http.mjs';
import { findAdminPassword } from '../src/secret.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const TOKEN = arg('token') || process.env.CF_API_TOKEN;
if (!TOKEN) { console.error('缺少 CF_API_TOKEN'); process.exit(1); }
const DRY = has('dry-run');
const PROXY = parseProxy(process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897');
const API = 'https://api.cloudflare.com/client/v4';
const PROJECT = arg('project', 'ipauto-edge');
const KV_ID = arg('kv', '3e273048175f46438c6db20d360a68e6');
const ACCOUNT = String(arg('account', process.env.CF_ACCOUNT_ID || ''));
const ADMIN = arg('admin', process.env.EDGETUNNEL_ADMIN || findAdminPassword() || crypto.randomBytes(9).toString('base64url'));
const UUID = arg('uuid', '2900cf6a-b708-4358-8d38-189a4ad4cae7');
const SRC = path.join(ROOT, '_src/cmliu_edgetunnel/_worker.js');
const COMPAT_DATE = '2025-11-04';
const STAGE = path.join(ROOT, 'logs/edge-deploy');

async function cf(method, endpoint, { body = null, headers = {}, raw = false } = {}) {
  const h = { authorization: `Bearer ${TOKEN}`, ...headers };
  const r = await httpRequest(`${API}${endpoint}`, { proxy: PROXY, method, headers: h, body, timeoutMs: 180000 });
  if (raw) return r;
  let j;
  try { j = JSON.parse(r.body); } catch { throw new Error(`${method} ${endpoint} → HTTP ${r.status} 非 JSON: ${r.body.slice(0, 200)}`); }
  if (!j.success) {
    const detail = (j.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${r.status}`;
    const err = new Error(`${method} ${endpoint} → ${detail}`);
    err.status = r.status; err.cfErrors = j.errors;
    throw err;
  }
  return j.result;
}

const log = (...a) => console.log(...a);

/* ---------- 1. 账号 ---------- */
const me = await cf('GET', '/user');
log(`账号: ${me.email}`);
const accounts = await cf('GET', '/accounts?per_page=50');
const acc = (ACCOUNT && accounts.find((a) => a.id === ACCOUNT || a.name === ACCOUNT)) || accounts[0];
log(`账户: ${acc.name} (${acc.id})`);

/* ---------- 2. 项目 ---------- */
let project = null;
try {
  project = await cf('GET', `/accounts/${acc.id}/pages/projects/${PROJECT}`);
  log(`项目已存在: ${project.name} → ${project.subdomain}`);
} catch (e) {
  if (e.status !== 404) throw e;
  log(`项目不存在，创建: ${PROJECT}`);
  if (!DRY) {
    project = await cf('POST', `/accounts/${acc.id}/pages/projects`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: PROJECT, production_branch: 'main' }),
    });
    log(`已创建: ${project.subdomain}`);
  }
}

/* ---------- 3. 绑定 KV + ADMIN + UUID + HOST ----------
 * UUID 与 HOST 是关键：_worker.js:34 的 envUUID 取自 env.UUID，
 * 若为空且 KV 里还没有 config.json，会落进 `_worker.js:502` 的 !envUUID 分支
 * ——fetch `https://edt-pages.github.io/noKV` 再返回 404 空体，
 * 表现为整站除了根路径全是 404。显式给 UUID/HOST 即可绕开。 */
if (!DRY) {
  const patched = await cf('PATCH', `/accounts/${acc.id}/pages/projects/${PROJECT}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deployment_configs: {
        production: {
          compatibility_date: COMPAT_DATE,
          compatibility_flags: ['nodejs_compat'],
          kv_namespaces: { KV: { namespace_id: KV_ID } },
          env_vars: {
            ADMIN: { value: ADMIN },
            UUID: { value: UUID },
            HOST: { value: `${PROJECT}.pages.dev` },
          },
        },
      },
    }),
  });
  const prod = patched.deployment_configs?.production || {};
  log(`绑定: KV→${prod.kv_namespaces?.KV?.namespace_id || '?'}  ADMIN→${prod.env_vars?.ADMIN?.value ? '已设置' : '未设置'}`);
  log(`      UUID→${prod.env_vars?.UUID?.value || '未设置'}  HOST→${prod.env_vars?.HOST?.value || '未设置'}`);
}
if (DRY) { log('--dry-run：到此为止'); process.exit(0); }

/* ---------- 4. 用 wrangler 上传 _worker.js ---------- */
if (!fs.existsSync(SRC)) throw new Error(`找不到 ${SRC}`);
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.copyFileSync(SRC, path.join(STAGE, '_worker.js'));
log(`上传目录 ${STAGE}  (${(fs.statSync(SRC).size / 1024 / 1024).toFixed(2)} MB)`);

const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: acc.id,
  https_proxy: process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897',
  http_proxy: process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897',
};
let out = '';
try {
  out = execFileSync('wrangler', ['pages', 'deploy', '.', '--project-name', PROJECT, '--branch', 'main', '--commit-dirty=true'], {
    cwd: STAGE, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  out = `${e.stdout || ''}${e.stderr || ''}`;
  const hint = /does not exist/.test(out) ? '\n提示：项目不存在，先 `wrangler pages project create ' + PROJECT + ' --production-branch main`' : '';
  throw new Error(`wrangler 部署失败：${out.trim().split('\n').slice(-6).join(' | ')}${hint}`);
}
const urlHit = out.match(/https:\/\/[a-z0-9]+\.${PROJECT}\.pages\.dev/i) || out.match(/https:\/\/[a-z0-9]+\.pages\.dev/i);
log(`wrangler: ${out.trim().split('\n').filter((l) => /Deployment complete|Success/.test(l)).join(' ')}`);

/* ---------- 5. 自检 ---------- */
const base = `https://${PROJECT}.pages.dev`;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const MD5MD5 = (t) => md5(md5(t).slice(7, 27));
const token = MD5MD5(`${PROJECT}.pages.dev${UUID}`);
await new Promise((r) => setTimeout(r, 8000));
const checks = [];
for (const p of [`/version?uuid=${UUID}`, '/login', `/sub?token=${token}`]) {
  try {
    const r = await httpRequest(`${base}${p}`, { proxy: PROXY, timeoutMs: 60000, headers: { 'user-agent': 'v2rayN/6.31' } });
    checks.push(`${p} → HTTP ${r.status} ${r.body.length}B`);
  } catch (e) {
    checks.push(`${p} → ${e.message}`);
  }
}
checks.forEach((c) => log(`  ${c}`));

log(`\n完成: ${base}`);
log(`  后台 ${base}/admin   密码 ${ADMIN}`);
log(`  订阅 ${base}/sub?token=${token}`);
fs.writeFileSync(path.join(ROOT, 'logs/pages-edge.json'), JSON.stringify({
  project: PROJECT, project_id: project?.id, account_id: acc.id, url: base,
  deploy_url: urlHit?.[0] || null, kv_id: KV_ID, admin: ADMIN, uuid: UUID, token,
  checks, at: new Date().toISOString(),
}, null, 2));
