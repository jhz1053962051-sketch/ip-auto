/** 调试：直连 pages.dev 打 /admin/check，打印状态/头/耗时，定位 rankByWorker 超时的原因。 */
import { httpRequest, parseProxy } from '../src/http.mjs';
import { loginWorker } from '../src/workerrank.mjs';
import { findAdminPassword } from '../src/secret.mjs';

const base = 'https://ipauto-edge.pages.dev';
const ua = 'ip-auto-rank/1.0';
const cookie = await loginWorker({ base, password: findAdminPassword(), ua, proxy: null });
console.log('cookie', cookie);

for (const q of ['http=8.209.255.13:3128', 'sstp=vpn:vpn@vpn492686662.opengw.net:1591']) {
  const t0 = Date.now();
  try {
    const r = await httpRequest(`${base}/admin/check?${q}`, {
      proxy: null,
      timeoutMs: 45000,
      headers: { cookie, 'user-agent': ua },
    });
    console.log(`${q} → HTTP ${r.status} ${Date.now() - t0}ms`);
    console.log('  headers:', JSON.stringify(r.headers));
    console.log('  body:', String(r.body).slice(0, 200).replace(/\n/g, ' '));
  } catch (e) {
    console.log(`${q} → FAIL ${Date.now() - t0}ms ${e.message}`);
  }
}
process.exit(0);
