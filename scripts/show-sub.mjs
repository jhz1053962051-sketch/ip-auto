/**
 * 打印当前订阅地址（不需要打开浏览器、不需要后台密码）。
 *
 * token 不是简单 md5：edgetunnel 用的是 MD5MD5(t) = md5(md5(t).slice(7, 27))，
 * 见 _src/cmliu_edgetunnel/_worker.js:5403，调用处 _worker.js:89
 *   params.set('token', await MD5MD5(host + userID))
 *
 * 用法:
 *   node scripts/show-sub.mjs                 # 用 logs 里的部署回执
 *   node scripts/show-sub.mjs --host https://xxx.pages.dev --uuid xxx
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
/** edgetunnel 的 MD5MD5：外层 md5 只吃内层 md5 十六进制串的第 7..27 位 */
export const MD5MD5 = (t) => md5(md5(t).slice(7, 27));

// 依次尝试从部署回执里取 host 和 uuid
function readReceipts() {
  const out = {};
  const pages = path.join(ROOT, 'logs/pages-edge.json');
  if (fs.existsSync(pages)) {
    const j = JSON.parse(fs.readFileSync(pages, 'utf8'));
    if (j.url) {
      // 回执里的 url 形如 https://<deployment-id>.ipauto-edge.pages.dev，
      // 那是「这次部署」的别名，不是生产域名；订阅要用生产域名，否则 token 对不上。
      const host = String(j.url).replace(/^https?:\/\//, '').split('/')[0];
      out.host = host.replace(/^[0-9a-f]{8}\./, '');
    }
    if (j.uuid) out.uuid = j.uuid;
  }
  const cf = path.join(ROOT, 'logs/cloudflare-deploy.json');
  if (fs.existsSync(cf)) {
    const j = JSON.parse(fs.readFileSync(cf, 'utf8'));
    if (!out.uuid && j.edgetunnel?.uuid) out.uuid = j.edgetunnel.uuid;
  }
  return out;
}

const fromReceipt = readReceipts();
const HOST = (arg('host', fromReceipt.host || 'ipauto-edge.pages.dev')).replace(/^https?:\/\//, '').replace(/\/$/, '');
// 部署脚本里 UUID 是显式写进 Pages 环境变量的，回执可能没记，这里兜底
const UUID = arg('uuid', fromReceipt.uuid || process.env.IP_AUTO_UUID || '2900cf6a-b708-4358-8d38-189a4ad4cae7');

const token = MD5MD5(HOST + UUID);
const base = `https://${HOST}/sub?token=${token}`;

console.log('订阅地址');
console.log(`  ${base}`);
console.log('');
console.log('其它格式');
console.log(`  Clash   ${base}&clash`);
console.log(`  Base64  ${base}&base64`);
console.log('');
console.log('明细');
console.log(`  域名    ${HOST}`);
console.log(`  UUID    ${UUID}`);
console.log(`  token   ${token}   (MD5MD5 = md5(md5(host+uuid).slice(7,27)))`);
console.log(`  后台    https://${HOST}/admin   密码见 logs/pages-edge.json 的 admin 字段`);
