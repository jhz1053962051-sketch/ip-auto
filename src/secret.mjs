/**
 * 运行时凭据读取。
 *
 * 为什么单独抽一个文件：`src/workerrank.mjs` 要给线上 edgetunnel 的 `/admin/check`
 * 登录（拿 auth cookie），必须知道管理员密码。密码不能写死在源码里 —— 仓库是公开的，
 * 一旦提交就等于把后台交出去。所以优先级固定为：
 *
 *   1. 环境变量（CI 里走 GitHub Actions Secret，本地可临时 export）
 *   2. `logs/pages-edge.json`（`scripts/deploy-pages-edge.mjs` 部署时落盘的记录）
 *   3. `logs/cloudflare-deploy.json`（早期 Worker 版部署记录）
 *
 * 三者都拿不到就返回 null，由调用方决定是跳过 Worker 复测还是报错退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = [
  path.join(ROOT, 'logs/pages-edge.json'),
  path.join(ROOT, 'logs/cloudflare-deploy.json'),
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 从若干条已知路径里找管理员密码 */
export function findAdminPassword() {
  if (process.env.IP_AUTO_ADMIN) return process.env.IP_AUTO_ADMIN;
  if (process.env.EDGETUNNEL_ADMIN) return process.env.EDGETUNNEL_ADMIN;
  for (const file of CANDIDATES) {
    const j = readJson(file);
    if (!j) continue;
    const v = j.admin || j.ADMIN || j.password || j.adminPassword;
    if (v) return String(v);
  }
  return null;
}

/** 从部署记录里找 edgetunnel 的公开基址（Pages 生产域名优先） */
export function findEdgeBase() {
  if (process.env.IP_AUTO_EDGE_BASE) return process.env.IP_AUTO_EDGE_BASE;
  const pages = readJson(CANDIDATES[0]);
  const raw = pages?.url || pages?.pages_url;
  if (raw) {
    // 部署记录里存的是 `<hash>.ipauto-edge.pages.dev` 这种「部署别名」。
    // 订阅 token 是用生产域名算的（MD5MD5(host+uuid)），拿别名去请求必然 404 → 必须剥掉 hash 前缀。
    try {
      const u = new URL(String(raw));
      const parts = u.hostname.split('.');
      if (parts.length > 3 && /^[0-9a-f]{8}(-[0-9a-f]{4})?$/.test(parts[0])) parts.shift();
      return `${u.protocol}//${parts.join('.')}`;
    } catch {
      return String(raw);
    }
  }
  const worker = readJson(CANDIDATES[1]);
  if (worker?.edgetunnel?.url) return String(worker.edgetunnel.url);
  return 'https://ipauto-edge.pages.dev';
}

/** 从部署记录里找 UUID */
export function findUuid() {
  if (process.env.IP_AUTO_UUID) return process.env.IP_AUTO_UUID;
  for (const file of CANDIDATES) {
    const j = readJson(file);
    if (!j) continue;
    const v = j.uuid || j.UUID;
    if (v) return String(v);
  }
  return '2900cf6a-b708-4358-8d38-189a4ad4cae7';
}
