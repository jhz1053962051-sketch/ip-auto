/**
 * 把 edgetunnel 管理员密码写进 GitHub Actions Secret（`EDGETUNNEL_ADMIN`）。
 *
 * 为什么需要：流水线里的「Worker 侧延迟复测」要登录线上 edgetunnel 的 /admin/check，
 * 而仓库是公开的 —— 密码只能走 Actions Secret，不能出现在 workflow 或源码里。
 *
 * GitHub 要求 secret 用仓库公钥做 libsodium sealed box 加密后再上传，
 * Node 没有内置 libsodium，所以这里用 `logs/secretsetup` 里的临时依赖（已 gitignore）。
 *
 * 用法：
 *   GH_TOKEN=xxx node scripts/set-gh-secret.mjs [--repo OWNER/REPO] [--name EDGETUNNEL_ADMIN]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const TOKEN = arg('token') || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }
const REPO = arg('repo', 'jhz1053962051-sketch/ip-auto');
const NAME = arg('name', 'EDGETUNNEL_ADMIN');

/* 密码来源：环境变量 → logs/pages-edge.json */
let secretValue = process.env.EDGETUNNEL_ADMIN || process.env.IP_AUTO_ADMIN;
if (!secretValue) {
  const f = path.join(ROOT, 'logs/pages-edge.json');
  secretValue = JSON.parse(fs.readFileSync(f, 'utf8')).admin;
}
if (!secretValue) { console.error('拿不到要上传的值'); process.exit(1); }

/* libsodium 从 logs/secretsetup 里加载，不污染主项目依赖。
 * Windows 下动态 import 的路径必须是 file:// URL，直接传 `C:\...` 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。 */
const sodiumPath = path.join(ROOT, 'logs/secretsetup/node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js');
const sodiumMod = await import(new URL(`file://${sodiumPath.replace(/\\/g, '/')}`).href);
const sodium = sodiumMod.default || sodiumMod;
await sodium.ready;

function gh(method, endpoint, body) {
  const out = execFileSync('curl', [
    '-sS', '-m', '40',
    '-X', method,
    `https://api.github.com${endpoint}`,
    '-H', `authorization: Bearer ${TOKEN}`,
    '-H', 'accept: application/vnd.github+json',
    '-H', 'x-github-api-version: 2022-11-28',
    '-H', 'user-agent: ip-auto-secret',
    ...(body === undefined ? [] : ['-H', 'content-type: application/json', '-d', JSON.stringify(body)]),
  ], { encoding: 'utf8', env: { ...process.env, https_proxy: process.env.https_proxy || 'http://127.0.0.1:7897' } });
  return out ? JSON.parse(out) : null;
}

const pk = gh('GET', `/repos/${REPO}/actions/secrets/public-key`);
if (!pk?.key) { console.error('拿不到仓库公钥', pk); process.exit(1); }

const binKey = Buffer.from(pk.key, 'base64');
const enc = sodium.crypto_box_seal(Buffer.from(secretValue, 'utf8'), binKey);
const encrypted_value = Buffer.from(enc).toString('base64');

gh('PUT', `/repos/${REPO}/actions/secrets/${NAME}`, {
  encrypted_value,
  key_id: pk.key_id,
});

const list = gh('GET', `/repos/${REPO}/actions/secrets`);
const hit = (list.secrets || []).find((s) => s.name === NAME);
console.log(`已写入 ${REPO} → ${NAME}`);
console.log(`  存在: ${hit ? '是' : '否'}  更新时间: ${hit?.updated_at || '-'}`);
