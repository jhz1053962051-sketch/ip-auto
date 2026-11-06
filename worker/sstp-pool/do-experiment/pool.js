/**
 * SSTP 预热池 Durable Object（单实例管多节点）。
 *
 * 为什么单实例：一个节点一个 DO 的话，每个实例都要靠 alarm 续命，
 * 50 个节点 = 每分钟几百次 DO 请求，纯浪费。个人代理并发不高，一个实例够用，
 * 也只需要一条 alarm。
 *
 * 池子里每条隧道 = 一个已完成 TLS + SSTP_DUPLEX_POST + PPP(LCP/PAP/IPCP) 的会话，
 * 只等 dial(目标) 做隧道内 TCP 握手。一条隧道只能服务一个客户端连接（PPP 是单五元组），
 * 用掉即弃，靠 fill() 补水。
 *
 * 与边缘 Worker 之间走 fetch 双向流：请求体 = 上行字节，响应体 = 下行字节。
 */
import { openTunnel } from './sstp.js';

const IDLE_TTL_MS = 4000;      // 建好后太久没被取走就丢掉重开（避免半死隧道）
const MAX_TOTAL = 16;          // 所有节点加起来最多几条
const DEFAULT_SIZE = 3;        // 每个节点默认预热几条
const TUNNEL_TIMEOUT_MS = 20000;

export function parseProxyString(str) {
	const m = /^sstp:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+):(\d+)$/i.exec(String(str || '').trim());
	if (!m) return null;
	return { username: m[1] ? decodeURIComponent(m[1]) : null, password: m[2] != null ? decodeURIComponent(m[2]) : null, hostname: m[3], port: Number(m[4]) };
}

export class SstpPool {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.configs = new Map();   // node -> {proxy, size}
		this.ready = [];            // {node, tunnel, bornAt}
		this.pending = new Map();   // node -> 正在建的数量
		this.stats = { opened: 0, used: 0, failed: 0, coldTakes: 0, warmTakes: 0 };
	}

	async load() {
		if (this.configs.size) return;
		try {
			const saved = await this.state.storage.get('configs');
			for (const [node, cfg] of Object.entries(saved || {})) this.configs.set(node, cfg);
		} catch (e) { }
	}

	async save() {
		const out = {};
		for (const [node, cfg] of this.configs) out[node] = cfg;
		try { await this.state.storage.put('configs', out); } catch (e) { }
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (url.pathname === '/warm') return await this.handleWarm(request);
			if (url.pathname === '/stats') return await this.handleStats();
			if (url.pathname === '/take') return await this.handleTake(request, url);
		} catch (error) {
			return new Response(`pool error: ${error.message}`, { status: 500 });
		}
		return new Response('not found', { status: 404 });
	}

	async handleWarm(request) {
		await this.load();
		const body = await request.json();
		const node = String(body.proxy || '');
		const proxy = parseProxyString(node);
		if (!proxy) return new Response('bad proxy', { status: 400 });
		const size = Math.max(0, Math.min(MAX_TOTAL, Number(body.size) || DEFAULT_SIZE));
		this.configs.set(node, { proxy, size });
		await this.save();
		this.prune();
		this.fill();
		await this.arm(5000);
		return Response.json({ ok: true, ready: this.ready.length, pending: this.pendingCount() });
	}

	async handleStats() {
		await this.load();
		this.prune();
		return Response.json({
			nodes: [...this.configs.entries()].map(([node, cfg]) => ({
				node, size: cfg.size,
				ready: this.ready.filter((item) => item.node === node).length,
				pending: this.pending.get(node) || 0
			})),
			totalReady: this.ready.length,
			totalPending: this.pendingCount(),
			stats: this.stats,
			ages: this.ready.map((item) => Date.now() - item.bornAt)
		});
	}

	/**
	 * 关键路径：优先拿一条预热好的，没有再现场开。
	 * ?warm=0 强制冷启动（用来对照）。
	 */
	async handleTake(request, url) {
		await this.load();
		const node = url.searchParams.get('node') || '';
		const host = url.searchParams.get('host');
		const port = Number(url.searchParams.get('port')) || 80;
		const allowCold = url.searchParams.get('cold') !== '0';
		const budget = Number(url.searchParams.get('budget')) || 9000;
		if (!node || !host) return new Response('missing node/host', { status: 400 });

		let cfg = this.configs.get(node);
		if (!cfg) {
			const proxy = parseProxyString(node);
			if (!proxy) return new Response('bad node', { status: 400 });
			cfg = { proxy, size: DEFAULT_SIZE };
			this.configs.set(node, cfg);
			await this.save();
			this.fill();
		}

		const startedAt = Date.now();
		for (let attempt = 0; attempt < 2; attempt++) {
			this.prune();
			const entry = this.takeReady(node);
			const warm = Boolean(entry);
			let tunnel = entry?.tunnel || null;
			if (!tunnel) {
				if (!allowCold || attempt > 0) break;
				this.stats.coldTakes++;
				tunnel = await this.openOne(node);
				if (!tunnel) break;
			} else {
				this.stats.warmTakes++;
			}
			try {
				const conn = await tunnel.dial(host, port, { timeoutMs: budget });
				this.stats.used++;
				this.fill();
				this.arm(5000);
				const setupMs = Date.now() - startedAt;
				if (request.body) request.body.pipeTo(conn.writable).catch(() => { try { conn.close(); } catch (e) { } });
				return new Response(conn.readable, {
					status: 200,
					headers: { 'x-sstp-warm': warm ? '1' : '0', 'x-sstp-setup-ms': String(setupMs) }
				});
			} catch (error) {
				this.stats.failed++;
				try { tunnel.close?.(error.message); } catch (e) { }
			}
		}
		return new Response('sstp dial failed', { status: 502 });
	}

	takeReady(node) {
		for (let index = this.ready.length - 1; index >= 0; index--) {
			if (this.ready[index].node !== node) continue;
			const [entry] = this.ready.splice(index, 1);
			return entry;
		}
		return null;
	}

	pendingCount() {
		let total = 0;
		for (const value of this.pending.values()) total += value;
		return total;
	}

	prune() {
		const now = Date.now();
		this.ready = this.ready.filter((entry) => {
			if (now - entry.bornAt <= IDLE_TTL_MS) return true;
			try { entry.tunnel.close?.('空闲超时'); } catch (e) { }
			return false;
		});
	}

	async openOne(node) {
		const cfg = this.configs.get(node);
		if (!cfg) return null;
		this.pending.set(node, (this.pending.get(node) || 0) + 1);
		try {
			const tunnel = await openTunnel(cfg.proxy, { timeoutMs: TUNNEL_TIMEOUT_MS });
			this.stats.opened++;
			return tunnel;
		} catch (error) {
			this.stats.failed++;
			return null;
		} finally {
			const left = (this.pending.get(node) || 1) - 1;
			if (left > 0) this.pending.set(node, left); else this.pending.delete(node);
		}
	}

	/** 按各节点配置补水，总量不超过 MAX_TOTAL */
	fill() {
		let budget = MAX_TOTAL - this.ready.length - this.pendingCount();
		if (budget <= 0) return;
		for (const [node, cfg] of this.configs) {
			const have = this.ready.filter((item) => item.node === node).length + (this.pending.get(node) || 0);
			let need = Math.max(0, cfg.size - have);
			while (need-- > 0 && budget-- > 0) {
				this.openOne(node).then((tunnel) => {
					if (!tunnel) return;
					if (this.ready.length >= MAX_TOTAL) { try { tunnel.close?.('池满'); } catch (e) { } return; }
					this.ready.push({ node, tunnel, bornAt: Date.now() });
				}).catch(() => { });
			}
		}
	}

	async arm(delayMs) {
		try {
			const current = await this.state.storage.getAlarm();
			if (current == null) await this.state.storage.setAlarm(Date.now() + delayMs);
		} catch (e) { }
	}

	async alarm() {
		await this.load();
		this.prune();
		this.fill();
		const short = this.ready.length < Math.min(MAX_TOTAL, [...this.configs.values()].reduce((sum, cfg) => sum + cfg.size, 0));
		await this.arm(short ? 3000 : 15000);
	}
}