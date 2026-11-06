/**
 * 预热池入口 Worker。
 *   POST /warm?node=sstp://user:pass@host:port&size=3   配好这个节点的池子并开始预热
 *   GET  /stats?node=...                                看池子状态
 *   POST /take?node=...&host=..&port=..                  取一条隧道（body 上行 / 响应体下行）
 *   GET  /probe?node=...&host=..&port=..&path=/          预热 vs 冷启动的端到端计时（自测用）
 */
export { SstpPool } from './pool.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function poolStub(env, node) {
	return env.SSTP_POOL.get(env.SSTP_POOL.idFromName(node));
}

async function coldProbe(node, host, port, path) {
	const { openTunnel } = await import('./sstp.js');
	const m = /^sstp:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+):(\d+)$/i.exec(node);
	if (!m) throw new Error('bad node');
	const t0 = Date.now();
	const tunnel = await openTunnel({ username: m[1] || null, password: m[2] ?? null, hostname: m[3], port: Number(m[4]) });
	const openedMs = Date.now() - t0;
	const conn = await tunnel.dial(host, port, { timeoutMs: 8000 });
	const dialedMs = Date.now() - t0;
	const writer = conn.writable.getWriter();
	const reader = conn.readable.getReader();
	await writer.write(enc.encode(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: pool-probe\r\n\r\n`));
	const { value } = await reader.read();
	return {
		mode: 'cold', openMs: openedMs, dialMs: dialedMs - openedMs, firstByteMs: Date.now() - t0,
		sample: dec.decode((value || new Uint8Array()).slice(0, 120)).split('\r\n')[0]
	};
}

async function warmProbe(env, node, host, port, path) {
	const stub = poolStub(env, node);
	await stub.fetch(new Request(`https://pool/warm?size=2`, {
		method: 'POST', body: JSON.stringify({ proxy: node, size: 2 }), headers: { 'content-type': 'application/json' }
	}));
	const t0 = Date.now();
	const { readable, writable } = new TransformStream();
	const response = await stub.fetch(new Request(`https://pool/take?host=${encodeURIComponent(host)}&port=${port}`, {
		method: 'POST', body: readable
	}));
	const headersMs = Date.now() - t0;
	if (response.status !== 200) return { mode: 'warm', error: `take ${response.status}`, headersMs };
	const writer = writable.getWriter();
	const reader = response.body.getReader();
	await writer.write(enc.encode(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: pool-probe\r\n\r\n`));
	const { value } = await reader.read();
	return {
		mode: 'warm', warm: response.headers.get('x-sstp-warm'), setupMs: Number(response.headers.get('x-sstp-setup-ms')),
		headersMs, firstByteMs: Date.now() - t0,
		sample: dec.decode((value || new Uint8Array()).slice(0, 120)).split('\r\n')[0]
	};
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const node = url.searchParams.get('node');
		if (!node) return new Response('missing node', { status: 400 });

		if (url.pathname === '/probe') {
			const host = url.searchParams.get('host') || 'cloudflare.com';
			const port = Number(url.searchParams.get('port')) || 80;
			const path = url.searchParams.get('path') || '/cdn-cgi/trace';
			const mode = url.searchParams.get('mode') || 'both';
			const out = {};
			try { if (mode !== 'warm') out.cold = await coldProbe(node, host, port, path); } catch (e) { out.cold = { error: e.message }; }
			try { if (mode !== 'cold') out.warm = await warmProbe(env, node, host, port, path); } catch (e) { out.warm = { error: e.message }; }
			return Response.json(out);
		}

		const stub = poolStub(env, node);
		const target = new URL(url.pathname + url.search, 'https://pool');
		return stub.fetch(new Request(target, request));
	}
};