/**
 * 预热池效果验证（纯 Node，不依赖 Cloudflare）：
 *   cold = 建隧道 + 隧道内 dial + 等首字节（等价于现在线上的行为）
 *   warm = 隧道已建好，只做 dial + 等首字节（预热池拿走之后剩下的成本）
 *
 * 用法: node test/pool-node.mjs [节点字符串] [--pool 2]
 *   节点字符串形如 sstp://vpn:vpn@public-vpn-47.opengw.net:443
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfConnectShim } from './connect-shim.mjs';
import { openTunnel } from '../worker/sstp-pool/sstp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function pickNode(explicit) {
	if (explicit && explicit.startsWith('sstp://')) return explicit;
	const file = path.join(ROOT, 'public', 'nodes.txt');
	const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
	for (const line of lines) {
		const m = /\$(sstp:\/\/\S+)/.exec(line);
		if (m) return m[1];
	}
	throw new Error('找不到 SSTP 节点');
}

function parseProxy(str) {
	const m = /^sstp:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+):(\d+)$/i.exec(str);
	if (!m) throw new Error(`无法解析: ${str}`);
	return { username: m[1] ? decodeURIComponent(m[1]) : null, password: m[2] != null ? decodeURIComponent(m[2]) : null, hostname: m[3], port: Number(m[4]) };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function probeThrough(conn, host, pathname, timeoutMs = 12000) {
	const writer = conn.writable.getWriter();
	const reader = conn.readable.getReader();
	await writer.write(enc.encode(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: pool-node/1.0\r\n\r\n`));
	const timer = setTimeout(() => { try { reader.cancel(); } catch (e) { } }, timeoutMs);
	try {
		let text = '';
		for (; ;) {
			const { value, done } = await reader.read();
			if (done) break;
			text += dec.decode(value, { stream: true });
			if (text.includes('\r\n\r\n')) break;
		}
		const status = text.split('\r\n')[0];
		const ipLine = text.split('\r\n').find((line) => line.startsWith('ip=')) || '';
		return { status, ipLine, bytes: text.length };
	} finally { clearTimeout(timer); }
}

async function main() {
	const argv = process.argv.slice(2);
	const poolSize = Number((argv.find((a) => a.startsWith('--pool=')) || '').split('=')[1]) || 2;
	const nodeStr = pickNode(argv.find((a) => a.startsWith('sstp://')));
	const proxy = parseProxy(nodeStr);
	console.log(`节点: ${nodeStr}`);
	console.log(`池大小: ${poolSize}\n`);

	// ---- 1) cold：不打池子，一次做完 ----
	const coldStart = Date.now();
	const tunnel = await openTunnel(proxy, { connect: cfConnectShim, log: () => { } });
	const openedMs = Date.now() - coldStart;
	const dialStart = Date.now();
	const conn = await tunnel.dial('cloudflare.com', 80, { timeoutMs: 10000 });
	const dialMs = Date.now() - dialStart;
	const firstByteStart = Date.now();
	const result = await probeThrough(conn, 'cloudflare.com', '/cdn-cgi/trace');
	const ttfbMs = Date.now() - firstByteStart;
	console.log('[cold] 建隧道 %sms | dial %sms | 首字节 %sms | 合计 %sms', openedMs, dialMs, ttfbMs, Date.now() - coldStart);
	console.log(`       出口: ${result.ipLine} (${result.status})`);
	try { conn.close(); } catch (e) { }

	// ---- 2) 预热：先建好 N 条隧道挂在池子里，再用 ----
	const pool = [];
	const warmBuildStart = Date.now();
	await Promise.all(Array.from({ length: poolSize }, async () => {
		try { pool.push(await openTunnel(proxy, { connect: cfConnectShim, log: () => { } })); } catch (e) { }
	}));
	console.log(`\n[pool] ${poolSize} 条隧道预热完成，用时 ${Date.now() - warmBuildStart}ms，成功 ${pool.length} 条`);

	for (let index = 0; index < pool.length; index++) {
		const start = Date.now();
		const warmDial = Date.now();
		let warmConn;
		try {
			warmConn = await pool[index].dial('cloudflare.com', 80, { timeoutMs: 10000 });
		} catch (error) {
			console.log(`[warm ${index}] dial 失败: ${error.message}`);
			continue;
		}
		const warmDialMs = Date.now() - warmDial;
		const warmResult = await probeThrough(warmConn, 'cloudflare.com', '/cdn-cgi/trace');
		console.log(`[warm ${index}] dial ${warmDialMs}ms | 首字节 ${Date.now() - start}ms | ${warmResult.ipLine}`);
		try { warmConn.close(); } catch (e) { }
	}

	// ---- 3) 同一条隧道复用第二个目标：应该失败（一隧道一连接） ----
	try {
		await pool[pool.length - 1]?.dial('example.com', 80, { timeoutMs: 6000 });
		console.log('\n[复用] 同一隧道 dial 第二个目标竟然成功 —— 与预期不符');
	} catch (error) {
		console.log(`\n[复用] 同一隧道第二个目标失败（符合预期）: ${error.message}`);
	}
}

main().catch((error) => { console.error('FAIL', error); process.exit(1); });