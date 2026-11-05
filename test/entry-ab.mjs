/**
 * 入口 A/B：同一个底层代理节点，只换 CF 入口，测真实请求耗时。
 *
 * 为什么一次只起一个 inbound：
 *   2026-11-05 那轮实验里，把 8 个 vless outbound（同 UUID、不同 entry）塞进同一个 Xray 进程，
 *   除第一个外全部 25~60s 超时 —— 疑似 Worker 侧同 UUID 连接互踢。所以这里严格串行：
 *   对每个 entry 单独写一个 xray 配置、单独起进程、测完杀掉。
 *
 * 判据：curl --socks5-hostname 打 gstatic generate_204，取 time_starttransfer。
 *   重复 N 次，报 min/p50，避免单次抖动误判。
 *
 * 用法：node test/entry-ab.mjs --node logs/sub-local.txt --index 0 --reps 3
 */
import fs from 'node:fs';
import {execFileSync, spawn} from 'node:child_process';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const SUB = arg('node', 'logs/sub-local.txt');
const INDEX = Number(arg('index', '0'));
const REPS = Number(arg('reps', '3'));
const BASE_PORT = Number(arg('base-port', '12100'));
const ENTRY_PORT = Number(arg('entry-port', '443'));
const TIMEOUT = Number(arg('timeout', '20'));

const ENTRIES = arg('entries', '104.27.0.1,spring.io,104.18.0.1,104.26.10.209,162.159.140.98,172.67.74.209,104.17.0.1,op.chinwa.eu.cc,172.64.152.5,cdn.ctn32.us.kg').split(',');

function parseVless(url) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams.entries());
  return {
    uuid: decodeURIComponent(u.username),
    host: u.hostname,
    port: Number(u.port || 443),
    path: q.path || '/',
    sni: q.sni || q.host || u.hostname,
    name: decodeURIComponent(u.hash.slice(1)),
  };
}

const raw = fs.readFileSync(SUB, 'utf8').split('\n').filter(l => l.startsWith('vless://'));
if (!raw.length) { console.error('订阅里没有 vless 节点'); process.exit(1); }
const node = parseVless(raw[INDEX]);
console.log(`底层节点：${node.name}  path=${node.path.slice(0, 40)}...`);

function makeConfig(entry, port) {
  return {
    log: {loglevel: 'warning'},
    inbounds: [{tag: 'in', port, listen: '127.0.0.1', protocol: 'socks', settings: {auth: 'noauth', udp: false}}],
    outbounds: [{
      tag: 'out', protocol: 'vless',
      settings: {vnext: [{address: entry, port: ENTRY_PORT, users: [{id: node.uuid, encryption: 'none'}]}]},
      streamSettings: {
        network: 'ws', security: 'tls',
        tlsSettings: {serverName: node.sni, allowInsecure: false, fingerprint: 'chrome', alpn: ['http/1.1']},
        wsSettings: {path: node.path, headers: {Host: node.sni}},
      },
    }],
  };
}

function killXray() {
  try { execFileSync('taskkill', ['/F', '/IM', 'xray.exe'], {stdio: 'ignore'}); } catch {}
}

async function probe(port) {
  const t0 = Date.now();
  try {
    const out = execFileSync('curl', [
      '-sS', '--max-time', String(TIMEOUT), '--noproxy', '',
      '--socks5-hostname', `127.0.0.1:${port}`,
      '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code} %{time_starttransfer}',
      'https://www.gstatic.com/generate_204',
    ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    const [code, ttfb] = out.trim().split(/\s+/);
    return {ok: code === '204', code, ms: Math.round(parseFloat(ttfb) * 1000), wall: Date.now() - t0};
  } catch (e) {
    const s = String(e.stderr || e.message || '').trim().split('\n')[0];
    return {ok: false, code: '000', ms: null, wall: Date.now() - t0, err: s.slice(0, 80)};
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];

for (let i = 0; i < ENTRIES.length; i++) {
  const entry = ENTRIES[i].trim();
  const port = BASE_PORT + i;
  killXray();
  await sleep(400);
  const cfgPath = `logs/ab-${i}.json`;
  fs.writeFileSync(cfgPath, JSON.stringify(makeConfig(entry, port)));
  const proc = spawn('./tools/xray.exe', ['run', '-c', cfgPath], {stdio: 'ignore', detached: false});
  await sleep(1600);  // 等 socks inbound 起来

  const samples = [];
  for (let r = 0; r < REPS; r++) {
    samples.push(await probe(port));
    await sleep(250);
  }
  const good = samples.filter(s => s.ok).map(s => s.ms);
  const min = good.length ? Math.min(...good) : null;
  const p50 = good.length ? good.sort((a, b) => a - b)[Math.floor(good.length / 2)] : null;
  const row = {entry, port, ok: good.length, of: REPS, min, p50, fails: samples.filter(s => !s.ok).map(s => s.err || s.code)};
  results.push(row);

  const bar = min === null ? '  ——  ' : String(min).padStart(5) + 'ms';
  console.log(`${String(i + 1).padStart(2)}. ${(entry + ' '.repeat(Math.max(0, 20 - entry.length)))} ${good.length}/${REPS}  min=${bar}  p50=${p50 === null ? '——' : p50 + 'ms'}` +
    (row.fails.length ? `  [${[...new Set(row.fails)].join('; ')}]` : ''));

  try { proc.kill('SIGKILL'); } catch {}
  await sleep(300);
}
killXray();

results.sort((a, b) => (a.min ?? 1e9) - (b.min ?? 1e9));
console.log('\n按最快单次排序：');
results.forEach((r, i) => console.log(`  ${i + 1}. ${r.entry}  ${r.min ?? '——'}${r.min ? 'ms' : ''}  (${r.ok}/${r.of} 成功)`));

fs.writeFileSync('logs/entry-ab.json', JSON.stringify({generated_at: new Date().toISOString(), base_node: node.name, results}, null, 2));
console.log('\n写入 logs/entry-ab.json');
