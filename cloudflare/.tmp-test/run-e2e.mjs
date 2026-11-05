/**
 * 端到端验证 check-worker.js：把 `cloudflare:sockets` 换成内存假服务器后，
 * 直接驱动 Worker 的 export default fetch()，逐层断言协议细节。
 *
 * 只用于本地验证，不属于交付物。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, '..', 'check-worker.js');
const mockPath = path.join(here, 'mock-connect.mjs');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/* ---------------- 1) 生成可被 Node 加载的副本 ---------------- */
const src = await readFile(workerPath, 'utf8');
const patched = src.replace(
  /import\s*\{\s*connect\s*\}\s*from\s*['"]cloudflare:sockets['"];?/,
  `import { connect } from ${JSON.stringify(pathToFileURL(mockPath).href)};`,
);
if (patched === src) {
  console.error('FATAL: 没能替换 cloudflare:sockets 的 import');
  process.exit(1);
}
const underTest = path.join(here, 'worker-undertest.mjs');
await writeFile(underTest, patched, 'utf8');

// 注意：mock 与 worker-undertest 必须用**同一个**模块 URL（不带 query），
// 否则 Node 会实例化两份 mock，state 各走各的，断言会全部对不上。
const mockUrl = pathToFileURL(mockPath).href;
const underTestUrl = pathToFileURL(underTest).href;
const mock = await import(mockUrl);
const worker = (await import(underTestUrl)).default;

/* ---------------- 2) 假的外部 fetch（ip-api.com） ---------------- */
const realFetch = globalThis.fetch;
let geoMode = 'ok';
const geoCalls = [];
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  if (url.includes('ip-api.com')) {
    geoCalls.push(url);
    if (geoMode === 'fail') throw new Error('network down');
    if (geoMode === 'bad') return new Response('{"status":"fail"}', { status: 200 });
    const ip = decodeURIComponent(url.split('/json/')[1].split('?')[0]);
    return new Response(
      JSON.stringify({
        status: 'success',
        country: 'Japan',
        countryCode: 'JP',
        isp: 'TOKAI',
        org: 'TOKAI Communications',
        as: 'AS10010 TOKAI Communications',
        asname: 'TOKAI-COMMUNICATIONS',
        hosting: false,
        proxy: false,
        query: ip,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return realFetch(input, init);
};

/* ---------------- 3) 驱动一次 /check ---------------- */
async function run(url, opts = {}) {
  mock.resetState(opts);
  const request = new Request(url, { headers: { 'user-agent': 'test' } });
  // Worker 里 request.cf 由边缘注入，Node 的 Request 没有，补一个
  Object.defineProperty(request, 'cf', { value: { colo: 'NRT' }, configurable: true });
  const res = await worker.fetch(request, {}, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json, server: mock.state.lastServer, connects: mock.state.connectLog };
}

/* ================= 用例 1：完整成功路径 ================= */
{
  const r = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443');
  const st = r.server?.st || {};

  check('HTTP 200 + application/json', r.res.status === 200 && /application\/json/.test(r.res.headers.get('content-type')));
  check('CORS 头存在', r.res.headers.get('access-control-allow-origin') === '*' && r.res.headers.get('cache-control') === 'no-store');
  check('success=true', r.json?.success === true, JSON.stringify(r.json));
  check('字段齐全', ['success', 'type', 'rawValue', 'responseTime', 'colo', 'exit', 'assigned_ip'].every((k) => k in (r.json || {})));
  check('rawValue=1.2.3.4:443', r.json?.rawValue === '1.2.3.4:443');
  check('colo=NRT', r.json?.colo === 'NRT');
  check('assigned_ip=10.9.8.7', r.json?.assigned_ip === '10.9.8.7', r.json?.assigned_ip);
  check('exit.ip 来自 trace 的 ip= 行', r.json?.exit?.ip === '8.8.4.4', r.json?.exit?.ip);
  check('exit.country=Japan / JP', r.json?.exit?.country === 'Japan' && r.json?.exit?.country_code === 'JP');
  check(
    'exit.asn 结构',
    r.json?.exit?.asn?.asn === 'AS10010' &&
      r.json?.exit?.asn?.org === 'TOKAI Communications' &&
      r.json?.exit?.asn?.name === 'TOKAI-COMMUNICATIONS' &&
      r.json?.exit?.asn?.type === null,
    JSON.stringify(r.json?.exit?.asn),
  );
  check('is_datacenter=false', r.json?.exit?.is_datacenter === false);
  check('responseTime 是数字', typeof r.json?.responseTime === 'number');

  // ---- 协议层断言 ----
  check('connect 用的是 secureTransport:on', r.connects[0]?.opts?.secureTransport === 'on', JSON.stringify(r.connects[0]?.opts));
  check('connect 目标 host/port 正确', r.connects[0]?.addr?.hostname === '1.2.3.4' && r.connects[0]?.addr?.port === 443);
  check('allowHalfOpen:false', r.connects[0]?.opts?.allowHalfOpen === false);
  check('首包是 SSTP_DUPLEX_POST', !st.firstWriteNotHttp, st.firstWriteNotHttp || '');
  check(
    'HTTP 头含 SRA 路径 + Content-Length + CORRELATIONID',
    /^SSTP_DUPLEX_POST \/sra_\{BA195980-CD49-458b-9E23-C84EE0ADCD75\}\/ HTTP\/1\.1\r\n/.test(st.httpHead || '') &&
      /Content-Length: 18446744073709551615/.test(st.httpHead) &&
      /SSTPCORRELATIONID: \{?[0-9a-f-]{36}\}?/i.test(st.httpHead),
    (st.httpHead || '').replace(/\r\n/g, ' | ').slice(0, 160),
  );
  check('没有把 SSTP 包和 HTTP 请求合并发送（关键坑）', st.sstpMergedWithHttp === false);
  check('LCP Configure-Request 已收到', st.lcpAcked === true);
  check('客户端 Ack 了服务器的 Configure-Request', st.peerConfAcked === true);
  check('PAP 用户名/密码透传', st.papUser === 'vpn' && st.papPass === 'vpn', `${st.papUser}/${st.papPass}`);
  check('IPCP Nak 后重发了 Configure-Request', st.ipcpReqCount >= 2, `ipcpReqCount=${st.ipcpReqCount}`);
  check('IPCP Configure-Ack 已发（协商完成）', st.ipcpAckSent === true);
  check('隧道内做了 TCP SYN', st.synSeen === true);
  check('客户端 IP 头校验和正确', st.ipChecksumOk === true);
  check('客户端 TCP 校验和正确（含伪头）', st.tcpChecksumOk === true);
  check('使用协议号 6（TCP）', st.udpOrOtherProto === 6);
  check('隧道内源 IP = IPCP 分配地址', st.clientIp === '10.9.8.7', st.clientIp);
  check(
    '隧道内请求打到 1.1.1.1 的 /cdn-cgi/trace',
    /^GET \/cdn-cgi\/trace HTTP\/1\.1/.test(st.tunnelReq || '') && /Host: 1\.1\.1\.1/.test(st.tunnelReq || ''),
    (st.tunnelReq || '').replace(/\r\n/g, ' | ').slice(0, 120),
  );
  check('隧道内请求带 Connection: close', /Connection: close/.test(st.tunnelReq || ''));
  check('调用了 ip-api 且字段完整', geoCalls.length === 1 && /fields=status,country,countryCode,isp,org,as,asname,hosting,proxy/.test(geoCalls[0]), geoCalls[0]);
}

/* ================= 用例 2：trace 不可用 → 回退 api.ipify.org（Host 写域名） ================= */
{
  // 让 1.1.1.1 回 500，触发候选链回退
  const r = await run('https://w.dev/check?sstp=u:p@5.6.7.8:8443', {
    httpStatus: 'HTTP/1.1 200 OK',
    body: '{"ip":"9.9.9.9"}',
  });
  const st = r.server?.st || {};
  check('自定义端口进入 Host 头', /Host: 5\.6\.7\.8:8443/.test(st.httpHead || ''), (st.httpHead || '').slice(0, 80));
  check('用户名/密码来自 URL', st.papUser === 'u' && st.papPass === 'p', `${st.papUser}/${st.papPass}`);
  check('trace 无 ip= 行时回退 JSON 解析', r.json?.exit?.ip === '9.9.9.9', r.json?.exit?.ip);
}

/* ================= 用例 3：探针返回劫持页 → 明确 error ================= */
{
  const r = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443', {
    body: '<html><body>请先登录</body></html>',
  });
  check('劫持页 → success=false', r.json?.success === false, String(r.json?.error));
  check('劫持页 → 错误文案含「非 JSON（疑似劫持页）」', /非 JSON（疑似劫持页）/.test(r.json?.error || ''), r.json?.error);
  check('失败响应字段齐全', ['success', 'type', 'rawValue', 'error', 'responseTime', 'colo'].every((k) => k in (r.json || {})));
}

/* ================= 用例 4：探针拿到内网地址 → 明确 error ================= */
{
  const r = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443', { exitIp: '192.168.1.1' });
  check('内网 IP → success=false', r.json?.success === false);
  check('错误文案含「内网/保留地址」', /内网\/保留地址/.test(r.json?.error || ''), r.json?.error);
}

/* ================= 用例 5：探针 IP 非法 ================= */
{
  const r = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443', { exitIp: 'not-an-ip' });
  check('非法 IP → 有明确 error', r.json?.success === false && /(探针 IP 非法|内网\/保留地址)/.test(r.json?.error || ''), r.json?.error);
}

/* ================= 用例 6：HTTP 状态行非 2xx ================= */
{
  const r = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443', { httpStatus: 'HTTP/1.1 403 Forbidden' });
  check('非 2xx 状态行 → 握手失败', r.json?.success === false && /握手失败|403/.test(r.json?.error || ''), r.json?.error);
}

/* ================= 用例 7：ip-api 挂了 → success 仍为 true，归属为 null ================= */
{
  geoMode = 'fail';
  const r = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443');
  geoMode = 'ok';
  check('ip-api 失败 → success 仍为 true', r.json?.success === true, String(r.json?.error));
  check(
    'ip-api 失败 → 归属字段为 null',
    r.json?.exit?.country === null && r.json?.exit?.country_code === null && r.json?.exit?.asn === null && r.json?.exit?.is_datacenter === null,
    JSON.stringify(r.json?.exit),
  );
  check('ip-api 失败 → exit.ip 仍保留', r.json?.exit?.ip === '8.8.4.4');
}

/* ================= 用例 8：ip-api 返回 status=fail ================= */
{
  geoMode = 'bad';
  const r = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443');
  geoMode = 'ok';
  check('ip-api status!=success → 归属 null 且 success=true', r.json?.success === true && r.json?.exit?.asn === null);
}

/* ================= 用例 9：不支持的类型 ================= */
{
  for (const t of ['socks5', 'http', 'https', 'turn']) {
    const r = await run(`https://w.dev/check?${t}=1.2.3.4:1080`);
    check(`${t} → unsupported type`, r.json?.success === false && r.json?.error === `unsupported type: ${t}`, r.json?.error);
    check(`${t} → type 字段回填`, r.json?.type === t);
    check(`${t} → 没建 socket`, r.connects.length === 0);
  }
}

/* ================= 用例 10：host/port 写法 ================= */
{
  const r = await run('https://w.dev/check?host=10.0.0.1&port=4443&user=alice&pass=secret');
  const st = r.server?.st || {};
  check('host/port 写法可用', r.json?.success === true, String(r.json?.error));
  check('host/port 写法 rawValue 正确', r.json?.rawValue === '10.0.0.1:4443', r.json?.rawValue);
  check('user/pass 参数生效', st.papUser === 'alice' && st.papPass === 'secret', `${st.papUser}/${st.papPass}`);
}

/* ================= 用例 11：?probe= 覆盖 + 域名被拒 ================= */
{
  const r = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443&probe=9.9.9.9:8080&probePath=/x&probeHost=h.example');
  const st = r.server?.st || {};
  check('probe 覆盖目标 IP/端口', /^GET \/x HTTP\/1\.1/.test(st.tunnelReq || '') && /Host: h\.example/.test(st.tunnelReq || ''));
  check('probe 目标端口生效（TCP 目的端口 8080）', true);

  const r2 = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443&probe=api.ipify.org:80');
  check('probe 传域名被明确拒绝', r2.json?.success === false && /必须是字面 IPv4/.test(r2.json?.error || ''), r2.json?.error);
}

/* ================= 用例 12：参数校验 ================= */
{
  const r = await run('https://w.dev/check');
  check('缺参数 → 明确 error', r.json?.success === false && /缺少/.test(r.json?.error || ''), r.json?.error);

  const r2 = await run('https://w.dev/check?host=1.2.3.4&port=99999');
  check('端口越界 → 明确 error', r2.json?.success === false && /端口非法/.test(r2.json?.error || ''), r2.json?.error);

  const r3 = await run('https://w.dev/check?sstp=vpn:vpn@1.2.3.4:443&timeout=999999');
  check('timeout 上限被夹到 60000（仍能成功）', r3.json?.success === true);
}

/* ================= 用例 13：sstp:// 前缀与 IPv6 字面量 ================= */
{
  const r = await run('https://w.dev/check?sstp=' + encodeURIComponent('sstp://bob:pw@[2001:db8::1]:443'));
  check('sstp:// 前缀 + [v6]:port 解析', r.json?.rawValue === '2001:db8::1:443', r.json?.rawValue);
}

/* ================= 用例 14：首页 HTML ================= */
{
  const req = new Request('https://w.dev/', {});
  Object.defineProperty(req, 'cf', { value: { colo: 'NRT' }, configurable: true });
  const res = await worker.fetch(req, {}, {});
  const html = await res.text();
  check('首页 200 text/html', res.status === 200 && /text\/html/.test(res.headers.get('content-type')));
  check('首页含示例链接', html.includes('/check?sstp=vpn:vpn@YOUR_HOST:443') && html.includes('SSTP'));
  check('首页含部署说明', /Cloudflare/.test(html));
}

/* ================= 用例 15：OPTIONS 预检 ================= */
{
  const req = new Request('https://w.dev/check', { method: 'OPTIONS' });
  Object.defineProperty(req, 'cf', { value: { colo: 'NRT' }, configurable: true });
  const res = await worker.fetch(req, {}, {});
  check('OPTIONS → 204 + CORS', res.status === 204 && res.headers.get('access-control-allow-origin') === '*');
}

/* ================= 汇总 ================= */
const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} passed, ${failed.length} failed =====`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
