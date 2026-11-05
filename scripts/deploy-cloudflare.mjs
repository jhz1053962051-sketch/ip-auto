/**
 * Cloudflare 一键部署（纯 API，不碰浏览器、不碰现有 Worker）
 *
 * 做的事情（全部幂等，重跑只会更新自己创建的那两个 Worker）：
 *   1. 校验 API Token、列出账号
 *   2. 确认 workers.dev 子域已开通
 *   3. 创建/复用 KV 命名空间 `EDGETUNNEL_KV`
 *   4. 上传 edgetunnel Worker（含 KV 绑定 + ADMIN 密码）
 *   5. 上传 SSTP 检测 Worker
 *   6. 打印两个可用地址，并自检 /check 接口
 *
 * 不会删除、不会修改任何已存在的其它 Worker / KV / 域名。
 *
 * 用法：
 *   set CF_API_TOKEN=xxxx            (Git Bash: export CF_API_TOKEN=xxxx)
 *   node scripts/deploy-cloudflare.mjs --dry-run     # 只看会做什么
 *   node scripts/deploy-cloudflare.mjs
 *
 * 可选参数：
 *   --token <t>         API Token（默认读环境变量 CF_API_TOKEN）
 *   --account <id|名字>  指定账号，默认取第一个
 *   --admin <密码>       edgetunnel 后台密码，默认随机生成并打印
 *   --prefix <name>      Worker 名字前缀，默认 ipauto
 *   --subdomain <name>   workers.dev 子域（首次开通时用），默认取账号名
 *   --dry-run            不落任何改动
 *
 * 需要的 Token 权限（自定义 Token 时勾这几项）：
 *   - Account → Workers Scripts → Edit
 *   - Account → Workers KV Storage → Edit
 *   - Account → Account Settings → Read
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.cloudflare.com/client/v4';

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
const TOKEN = String(args.token || process.env.CF_API_TOKEN || '').trim();
const DRY = Boolean(args['dry-run'] || args.dryRun);
const PREFIX = String(args.prefix || 'ipauto');
const ADMIN = String(args.admin || crypto.randomBytes(9).toString('base64url'));
const CHECK_NAME = `${PREFIX}-check-sstp`;
const EDGE_NAME = `${PREFIX}-edgetunnel`;
const KV_TITLE = `${PREFIX}-edgetunnel-KV`;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] !`, ...a);

if (!TOKEN) {
  console.error('缺少 API Token。到 https://dash.cloudflare.com/profile/api-tokens 创建，然后：');
  console.error('  export CF_API_TOKEN=xxxxx');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* API 封装                                                            */
/* ------------------------------------------------------------------ */
async function cf(method, endpoint, body, { raw = false, contentType = null } = {}) {
  const url = endpoint.startsWith('http') ? endpoint : API + endpoint;
  const headers = { authorization: `Bearer ${TOKEN}` };
  let payload;
  if (raw) {
    payload = body;
    if (contentType) headers['content-type'] = contentType;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || (json && json.success === false)) {
    const detail = json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || text.slice(0, 400);
    const err = new Error(`${method} ${endpoint} → HTTP ${res.status} ${detail}`);
    err.status = res.status;
    err.cfErrors = json?.errors;
    throw err;
  }
  return json?.result ?? json;
}

/** 文件 → Blob（multipart 上传 Worker 脚本用） */
function fileBlob(p) {
  const buf = fs.readFileSync(p);
  return new Blob([buf], { type: 'application/javascript+module' });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
(async () => {
  log('===== Cloudflare 部署开始 =====');
  log(`模式: ${DRY ? 'DRY-RUN（不做改动）' : '实际部署'}`);

  /* 1) 校验 token */
  const who = await cf('GET', '/user');
  log(`Token 有效，账号邮箱: ${who.email || '(未返回)'}`);

  /* 2) 选账号 */
  const accounts = await cf('GET', '/accounts?per_page=50');
  if (!accounts?.length) throw new Error('该 Token 下没有任何 Cloudflare 账号');
  let account = accounts[0];
  if (args.account) {
    const want = String(args.account).toLowerCase();
    const hit = accounts.find((a) => a.id === args.account || a.name?.toLowerCase() === want);
    if (!hit) throw new Error(`找不到账号 ${args.account}，可选：${accounts.map((a) => a.name).join(' / ')}`);
    account = hit;
  }
  const ACC = account.id;
  log(`使用账号: ${account.name} (${ACC})`);

  /* 3) workers.dev 子域 */
  let subdomain = null;
  try {
    const sd = await cf('GET', `/accounts/${ACC}/workers/subdomain`);
    subdomain = sd?.subdomain || null;
  } catch (e) {
    warn(`读取 workers.dev 子域失败: ${e.message}`);
  }
  if (!subdomain) {
    const want = String(args.subdomain || account.name || 'ipauto')
      .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'ipauto';
    if (DRY) {
      warn(`workers.dev 子域未开通，将尝试申请: ${want}`);
      subdomain = want;
    } else {
      log(`workers.dev 子域未开通，申请: ${want}`);
      const sd = await cf('PUT', `/accounts/${ACC}/workers/subdomain`, { subdomain: want });
      subdomain = sd?.subdomain || want;
    }
  }
  log(`workers.dev 子域: ${subdomain}`);

  /* 4) KV 命名空间 */
  const list = await cf('GET', `/accounts/${ACC}/storage/kv/namespaces?per_page=100`);
  let kv = (list || []).find((n) => n.title === KV_TITLE);
  if (kv) {
    log(`复用已有 KV: ${kv.title} (${kv.id})`);
  } else if (DRY) {
    warn(`将创建 KV 命名空间: ${KV_TITLE}`);
    kv = { id: '<<dry-run>>', title: KV_TITLE };
  } else {
    kv = await cf('POST', `/accounts/${ACC}/storage/kv/namespaces`, { title: KV_TITLE });
    log(`已创建 KV: ${kv.title} (${kv.id})`);
  }

  /* 5) 上传 edgetunnel */
  const edgeSrc = path.join(ROOT, '_src', 'cmliu_edgetunnel', '_worker.js');
  if (!fs.existsSync(edgeSrc)) throw new Error(`缺少 edgetunnel 源码: ${edgeSrc}`);
  const edgeBytes = fs.statSync(edgeSrc).size;
  log(`edgetunnel 源码 ${(edgeBytes / 1048576).toFixed(2)} MB`);

  const edgeMetadata = {
    main_module: 'worker.js',
    compatibility_date: '2025-11-04',
    bindings: [
      { type: 'kv_namespace', name: 'KV', namespace_id: kv.id },
      { type: 'plain_text', name: 'ADMIN', text: ADMIN },
    ],
    observability: { enabled: true },
  };

  if (DRY) {
    warn(`将上传 Worker: ${EDGE_NAME}（KV 绑定 + ADMIN）`);
  } else {
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify(edgeMetadata)], { type: 'application/json' }));
    fd.append('worker.js', fileBlob(edgeSrc), 'worker.js');
    const r = await cf('PUT', `/accounts/${ACC}/workers/scripts/${EDGE_NAME}`, fd, { raw: true });
    log(`已上传 ${EDGE_NAME}（modified ${r?.modified_on || 'ok'}）`);
    await cf('POST', `/accounts/${ACC}/workers/scripts/${EDGE_NAME}/subdomain`, { enabled: true }).catch((e) =>
      warn(`启用 workers.dev 路由失败（可稍后在面板手动开）: ${e.message}`));
  }

  /* 6) 上传检测 Worker */
  const checkSrc = path.join(ROOT, 'cloudflare', 'check-worker.js');
  if (!fs.existsSync(checkSrc)) throw new Error(`缺少检测 Worker 源码: ${checkSrc}`);
  const checkMetadata = {
    main_module: 'worker.js',
    compatibility_date: '2025-11-04',
    bindings: [],
    observability: { enabled: true },
  };
  if (DRY) {
    warn(`将上传 Worker: ${CHECK_NAME}`);
  } else {
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify(checkMetadata)], { type: 'application/json' }));
    fd.append('worker.js', fileBlob(checkSrc), 'worker.js');
    const r = await cf('PUT', `/accounts/${ACC}/workers/scripts/${CHECK_NAME}`, fd, { raw: true });
    log(`已上传 ${CHECK_NAME}（modified ${r?.modified_on || 'ok'}）`);
    await cf('POST', `/accounts/${ACC}/workers/scripts/${CHECK_NAME}/subdomain`, { enabled: true }).catch((e) =>
      warn(`启用 workers.dev 路由失败（可稍后在面板手动开）: ${e.message}`));
  }

  /* 7) 输出 */
  const edgeUrl = `https://${EDGE_NAME}.${subdomain}.workers.dev`;
  const checkUrl = `https://${CHECK_NAME}.${subdomain}.workers.dev`;
  const out = {
    account_id: ACC,
    account_name: account.name,
    workers_subdomain: subdomain,
    kv_namespace: { title: kv.title, id: kv.id },
    edgetunnel: { name: EDGE_NAME, url: edgeUrl, admin_url: `${edgeUrl}/admin`, admin_password: ADMIN },
    check_worker: { name: CHECK_NAME, url: checkUrl, sample: `${checkUrl}/check?sstp=vpn:vpn@HOST:PORT` },
  };

  const outFile = path.join(ROOT, 'logs', 'cloudflare-deploy.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  log('===== 部署结果 =====');
  log(`edgetunnel    ${edgeUrl}`);
  log(`  后台        ${edgeUrl}/admin    密码 ${ADMIN}`);
  log(`检测 Worker   ${checkUrl}`);
  log(`结果已写入 ${outFile}`);

  /* 8) 自检（仅实际部署时） */
  if (!DRY) {
    log('等待 5s 让路由生效后自检…');
    await new Promise((r) => setTimeout(r, 5000));
    for (const [label, u] of [['检测 Worker 根路径', `${checkUrl}/`], ['edgetunnel 根路径', `${edgeUrl}/`]]) {
      try {
        const res = await fetch(u, { redirect: 'manual' });
        log(`${label}: HTTP ${res.status}`);
      } catch (e) {
        warn(`${label} 自检失败: ${e.message}`);
      }
    }
  }
})().catch((e) => {
  console.error(`\n部署失败: ${e.message}`);
  if (e.status === 403) {
    console.error('提示：403 通常是 Token 权限不足。需要 Workers Scripts:Edit + Workers KV Storage:Edit。');
  }
  process.exit(1);
});
