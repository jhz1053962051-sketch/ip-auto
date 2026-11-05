/**
 * 把 edgetunnel 后台配置成「使用我们自己的 nodes.txt 订阅」
 * 纯 HTTP（走代理），不碰浏览器。
 *
 * 用法:
 *   node scripts/edgetunnel-setup.mjs --base https://x.workers.dev --password xxx \
 *        --nodes https://user.github.io/ip-auto/nodes.txt
 */
import { httpRequest, parseProxy } from '../src/http.mjs';

const args = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const v = process.argv[i + 1];
  if (v && !v.startsWith('--')) { args[a.slice(2)] = v; i++; } else args[a.slice(2)] = true;
}

const BASE = String(args.base || '').replace(/\/+$/, '');
const PASSWORD = args.password;
const NODES = args.nodes;
const PROXY = parseProxy(process.env.IP_AUTO_PROXY || 'http://127.0.0.1:7897');
if (!BASE || !PASSWORD || !NODES) {
  console.error('用法: node scripts/edgetunnel-setup.mjs --base https://xxx.workers.dev --password *** --nodes https://xxx/nodes.txt');
  process.exit(1);
}

let COOKIE = '';
async function req(path, { method = 'GET', body = null, headers = {}, cookie = true } = {}) {
  const h = { ...headers };
  if (cookie && COOKIE) h.cookie = COOKIE;
  const r = await httpRequest(BASE + path, { proxy: PROXY, method, body, headers: h, timeoutMs: 45000 });
  const sc = r.headers['set-cookie'];
  if (sc) {
    const m = String(Array.isArray(sc) ? sc[0] : sc).match(/auth=[^;]+/);
    if (m) COOKIE = m[0];
  }
  return r;
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// 1) 登录
const login = await req('/login', {
  method: 'POST',
  cookie: false,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: `password=${encodeURIComponent(PASSWORD)}`,
});
log('登录:', login.status, String(login.body).slice(0, 80));
if (login.status !== 200 || !COOKIE) {
  console.error('登录失败，检查管理员密码');
  process.exit(2);
}

// 2) 读配置
const cfgRes = await req(`/admin/config.json?_t=${Date.now()}`);
if (cfgRes.status !== 200) { console.error('读取配置失败', cfgRes.status); process.exit(3); }
const cfg = JSON.parse(cfgRes.body);
const sub = cfg['优选订阅生成'] || (cfg['优选订阅生成'] = {});
const lib = sub['本地IP库'] || (sub['本地IP库'] = {});
log('原配置: local=%s 随机IP=%s 随机数量=%s SUB=%s', sub.local, lib['随机IP'], lib['随机数量'], sub.SUB);

// 3) 改成「读 KV 里的 ADD.txt」
sub.local = true;
lib['随机IP'] = false;
sub.SUB = null;
if (!sub.SUBNAME) sub.SUBNAME = 'ip-auto';
if (!sub.SUBUpdateTime) sub.SUBUpdateTime = 3;

const save = await req('/admin/config.json', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(cfg),
});
log('保存配置:', save.status, String(save.body).slice(0, 100));

// 4) 写 ADD.txt：一行订阅地址；edgetunnel 会自动 fetch 并展开成全部节点
const addBody = `${NODES}\n`;
const add = await req('/admin/ADD.txt', {
  method: 'POST',
  headers: { 'content-type': 'text/plain;charset=utf-8' },
  body: addBody,
});
log('写入 ADD.txt:', add.status, String(add.body).slice(0, 100));

// 5) 回读确认
const back = await req('/admin/ADD.txt');
log('回读 ADD.txt:', back.status, JSON.stringify(String(back.body).slice(0, 200)));
const cfg2 = JSON.parse((await req(`/admin/config.json?_t=${Date.now()}`)).body);
log('回读配置: local=%s 随机IP=%s 随机数量=%s SUB=%s UUID=%s PATH=%s',
  cfg2['优选订阅生成'].local, cfg2['优选订阅生成']['本地IP库']['随机IP'],
  cfg2['优选订阅生成']['本地IP库']['随机数量'], cfg2['优选订阅生成'].SUB, cfg2.UUID, cfg2.PATH);
console.log(`\n订阅地址: ${BASE}/sub?token=${cfg2['优选订阅生成'].TOKEN}`);
console.log(`管理后台: ${BASE}/admin`);
