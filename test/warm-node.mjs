/**
 * 验证模块级预热池（warm.js）：真实 SSTP 节点上跑「冷 → 补水 → 热」。
 *
 * 用法：node test/warm-node.mjs [--node sstp://vpn:vpn@host:port] [--size 2]
 * 依赖：本机直连 VPN 服务器被掐，所以 SHIM_PROXY 走 127.0.0.1:7897。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cfConnectShim } from './connect-shim.mjs';
import { sstpAcquire, warmStats } from '../worker/sstp-pool/warm.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

function pickNode() {
	const given = arg('node');
	if (given) return given;
	const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data.json'), 'utf8'));
	const all = [];
	const groups = Array.isArray(data.countries) ? data.countries : Object.values(data.countries || {});
	for (const c of groups) for (const n of c.nodes || []) all.push(n);
	const sstp = all.filter((n) => String(n.link || '').startsWith('sstp://'));
	if (!sstp.length) throw new Error('data.json 里没有 sstp 节点');
	sstp.sort((a, b) => (a.real_ms || 1e9) - (b.real_ms || 1e9));
	return sstp[0].link;
}

function parse(uri) {
	const u = new URL(uri);
	return {
		hostname: u.hostname,
		port: Number(u.port) || 443,
		username: decodeURIComponent(u.username) || null,
		password: decodeURIComponent(u.password) || null,
	};
}

const nodeUri = pickNode();
const proxy = parse(nodeUri);
const size = Number(arg('size', '2'));
console.log(`节点 ${nodeUri}`);
console.log(`池大小 ${size}\n`);

const connect = (addr, opts) => cfConnectShim(addr, opts);

const t1 = Date.now();
const cold = await sstpAcquire(proxy, 'cloudflare.com', 80, { connect, size, log: (m) => console.log('  ' + m) });
console.log(`[cold] 首字节前 setup=${Date.now() - t1}ms warm=${cold.warm}`);
const res1 = await fetchTrace(cold.socket);
console.log(`[cold] ${res1}\n`);
cold.socket.close?.();

console.log('等 4s 让补水跑完…');
await new Promise((r) => setTimeout(r, 4000));
console.log('池状态', JSON.stringify(warmStats()), '\n');

for (let i = 0; i < size + 1; i++) {
	const t = Date.now();
	const got = await sstpAcquire(proxy, 'cloudflare.com', 80, { connect, size, log: (m) => console.log('  ' + m) });
	const setup = Date.now() - t;
	const trace = await fetchTrace(got.socket);
	console.log(`[take ${i}] warm=${got.warm} setup=${setup}ms → ${trace}`);
	got.socket.close?.();
	await new Promise((r) => setTimeout(r, 300));
}

async function fetchTrace(socket) {
	const writer = socket.writable.getWriter();
	const reader = socket.readable.getReader();
	await writer.write(new TextEncoder().encode(
		'GET /cdn-cgi/trace HTTP/1.1\r\nHost: cloudflare.com\r\nUser-Agent: warm-test\r\nConnection: close\r\n\r\n'
	));
	let text = '';
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const { value, done } = await Promise.race([
			reader.read(),
			new Promise((r) => setTimeout(() => r({ done: true }), 15000)),
		]);
		if (done) break;
		text += new TextDecoder().decode(value);
		if (text.includes('\nwarp=') || text.length > 4096) break;
	}
	try { reader.releaseLock(); } catch (e) { }
	const ip = (text.match(/^ip=(\S+)/m) || [])[1] || '?';
	const loc = (text.match(/^loc=(\S+)/m) || [])[1] || '?';
	const colo = (text.match(/^colo=(\S+)/m) || [])[1] || '?';
	const status = (text.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || '?';
	return `HTTP ${status} ip=${ip} loc=${loc} colo=${colo}`;
}