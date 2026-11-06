/**
 * 用 Node 的 net/tls 冒充 Cloudflare 的 connect()，把 sstp.js 直接跑在本机。
 * 目的：在不依赖 Cloudflare 账号 / workerd 的前提下，验证「隧道可预热、dial 只花一个 RTT」。
 *
 * 环境变量 SHIM_PROXY=http://127.0.0.1:7897 时先建 HTTP CONNECT 隧道（本机直连 VPN 服务器会被掐）。
 * 仅测试脚手架使用，线上 connect() 不需要这些。
 */
import net from 'node:net';
import tls from 'node:tls';
import { Readable, Writable } from 'node:stream';

/** 本机 getaddrinfo 对这些域名会 ENOENT，退回 DoH。 */
async function resolveHost(host) {
	try {
		const { lookup } = await import('node:dns/promises');
		const hit = await lookup(host, { family: 4 });
		return hit.address;
	} catch (e) { }
	const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: 'application/dns-json' } });
	const json = await response.json();
	const record = (json.Answer || []).find((item) => item.type === 1);
	if (!record) throw new Error(`DoH 无 A 记录: ${host}`);
	return record.data;
}

function dialThrough(raw, host, port) {
	const proxy = process.env.SHIM_PROXY || '';
	if (!proxy) {
		return resolveHost(host).then((ip) => new Promise((resolve, reject) => {
			raw.once('connect', resolve);
			raw.once('error', reject);
			raw.connect({ host: ip, port });
		}));
	}
	const proxyUrl = new URL(proxy);
	return new Promise((resolve, reject) => {
		raw.once('connect', () => {
			raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
			let head = '';
			const onData = (chunk) => {
				head += chunk.toString('latin1');
				if (!head.includes('\r\n\r\n')) return;
				raw.off('data', onData);
				const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) || [])[1]);
				if (status === 200) resolve();
				else reject(new Error(`CONNECT ${host}:${port} -> ${status || 'no-status'}`));
			};
			raw.on('data', onData);
		});
		raw.once('error', reject);
		raw.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) || 7897 });
	});
}

export function cfConnectShim(addr, opts = {}) {
	const isTls = opts.secureTransport === 'on';
	const host = addr.hostname;
	const port = Number(addr.port) || (isTls ? 443 : 80);

	let resolveOpened, rejectOpened;
	const opened = new Promise((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject; });

	const raw = new net.Socket();
	let streamRef = null;
	raw.once('error', (error) => rejectOpened(error));

	dialThrough(raw, host, port).then(() => {
		if (!isTls) { streamRef = raw; resolveOpened(); return; }
		const secure = tls.connect({ socket: raw, servername: host, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
		streamRef = secure;
		secure.once('secureConnect', () => resolveOpened());
		secure.once('error', (error) => rejectOpened(error));
		raw.once('close', () => { try { secure.destroy(); } catch (e) { } });
	}).catch((error) => rejectOpened(error));

	opened.catch(() => { });

	return {
		opened,
		get readable() { return Readable.toWeb(streamRef || raw); },
		get writable() { return Writable.toWeb(streamRef || raw); },
		close() {
			try { streamRef?.destroy?.(); } catch (e) { }
			try { raw.destroy(); } catch (e) { }
		}
	};
}