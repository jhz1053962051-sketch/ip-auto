/** 测试：本机不走代理，能否直连 VPN Gate 住宅节点的 SSTP 端口 */
import { connectTcp, tlsUpgrade } from '../src/http.mjs';
import fs from 'node:fs';
const lines = fs.readFileSync('public/nodes.txt','utf8').split(/\r?\n/).filter(Boolean).slice(0,8);
for (const line of lines) {
  const label = line.split('#')[1].split('$')[0];
  const m = line.match(/\$sstp:\/\/[^@]+@([^:]+):(\d+)/);
  if (!m) continue;
  const [, host, port] = m;
  const t0 = Date.now();
  try {
    const raw = await connectTcp(host, Number(port), null, 9000);
    console.log(`✅ TCP ${String(Date.now()-t0).padStart(5)}ms  ${label}  ${host}:${port}`);
    raw.destroy();
  } catch (e) {
    console.log(`❌ TCP ${String(Date.now()-t0).padStart(5)}ms  ${label}  ${host}:${port}  → ${e.message.slice(0,40)}`);
  }
}
