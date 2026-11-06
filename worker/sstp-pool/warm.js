/**
 * 模块级 SSTP 预热池（不用 Durable Object）
 *
 * 为什么不用 DO：Pages Functions 不支持 Durable Object 绑定，而线上入口正是
 * `ipauto-edge.pages.dev`（workers.dev 在本网络被 SNI 阻断）。所以池子放在
 * Worker isolate 的模块作用域里 —— 只要 isolate 被复用，下一个请求就能拿到
 * 已经建好的隧道。
 *
 * 语义：一条隧道只能服务一个客户端连接（PPP 是单五元组），取走即作废；
 * 取走之后立刻在 ctx.waitUntil 里补水，不占用响应时间。
 *
 * 效果（本机 Node shim 实测）：冷 1870ms → 预热命中 ~360ms。
 */
import { openTunnel } from './sstp.js';

const POOLS = new Map();
const DEFAULT_SIZE = 2;
const DEFAULT_IDLE_TTL_MS = 5000;
const DEFAULT_DIAL_TIMEOUT_MS = 8000;
const MAX_NODES = 6;

function keyOf(proxy) {
	const host = String(proxy?.hostname || '').toLowerCase();
	return `sstp://${host}:${Number(proxy?.port) || 443}`;
}

function poolFor(proxy) {
	const key = keyOf(proxy);
	let state = POOLS.get(key);
	if (!state) {
		if (POOLS.size >= MAX_NODES) {
			// 只保留最近活跃的若干节点，避免 isolate 里无限积累
			const oldest = [...POOLS.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
			if (oldest) {
				for (const item of oldest[1].list) { try { item.tunnel?.close?.('淘汰'); } catch (e) { } }
				POOLS.delete(oldest[0]);
			}
		}
		state = { proxy, list: [], inflight: 0, touched: Date.now() };
		POOLS.set(key, state);
	}
	state.proxy = proxy;
	state.touched = Date.now();
	return state;
}

function prune(state, ttlMs) {
	const keep = [];
	for (const item of state.list) {
		if (Date.now() - item.at > ttlMs) { try { item.tunnel?.close?.('过期'); } catch (e) { } }
		else keep.push(item);
	}
	state.list = keep;
	return state;
}

async function refill(state, { connect, log, size, idleTtlMs }) {
	prune(state, idleTtlMs);
	for (const item of [...state.list]) {
		if (item.tunnel?.closed?.then) {
			// 隧道在空闲期间被对端断掉的就别留着
			const dead = await Promise.race([
				item.tunnel.closed.then(() => true).catch(() => true),
				new Promise((r) => setTimeout(() => r(false), 0))
			]);
			if (dead) {
				try { item.tunnel.close?.('已断开'); } catch (e) { }
				state.list = state.list.filter((x) => x !== item);
			}
		}
	}
	while (state.list.length + state.inflight < size) {
		state.inflight++;
		try {
			const tunnel = await openTunnel(state.proxy, { connect, timeoutMs: 15000, log: () => { } });
			state.list.push({ tunnel, at: Date.now() });
		} catch (e) {
			log(`[预热池] 补水失败: ${e.message || e}`);
			break;
		} finally {
			state.inflight--;
		}
	}
}

/** 池子状态（自检用，别在热路径调） */
export function warmStats() {
	const out = {};
	for (const [key, state] of POOLS) out[key] = { ready: state.list.length, inflight: state.inflight };
	return out;
}

/**
 * 取连接：优先用预热隧道，其次冷启动。
 * @returns {Promise<{socket: {readable, writable, closed, close}, warm: boolean, setupMs: number}>}
 */
export async function sstpAcquire(proxy, host, port, options = {}) {
	const connect = options.connect;
	const log = options.log || (() => { });
	const ctx = options.ctx || null;
	const size = Math.max(0, Math.min(4, Number(options.size ?? DEFAULT_SIZE) || 0));
	const idleTtlMs = Math.max(1000, Number(options.idleTtlMs) || DEFAULT_IDLE_TTL_MS);
	const dialTimeoutMs = Number(options.dialTimeoutMs) || DEFAULT_DIAL_TIMEOUT_MS;

	const state = poolFor(proxy);
	prune(state, idleTtlMs);

	while (state.list.length) {
		const item = state.list.pop();
		try {
			const socket = await item.tunnel.dial(host, port, { timeoutMs: dialTimeoutMs });
			log(`[预热池] 命中，隧道已建 ${Date.now() - item.at}ms`);
			const task = refill(state, { connect, log, size, idleTtlMs });
			if (ctx?.waitUntil) ctx.waitUntil(task.catch(() => { })); else task.catch(() => { });
			return { socket, warm: true, setupMs: Date.now() - item.at };
		} catch (e) {
			log(`[预热池] 预热隧道不可用（${e.message || e}），换下一条`);
			try { item.tunnel.close?.('dial 失败'); } catch (err) { }
		}
	}

	const started = Date.now();
	const tunnel = await openTunnel(proxy, { connect, timeoutMs: 15000, log: () => { } });
	const socket = await tunnel.dial(host, port, { timeoutMs: dialTimeoutMs });
	log(`[预热池] 未命中，冷启动 ${Date.now() - started}ms`);
	const task = refill(state, { connect, log, size, idleTtlMs });
	if (ctx?.waitUntil) ctx.waitUntil(task.catch(() => { })); else task.catch(() => { });
	return { socket, warm: false, setupMs: Date.now() - started };
}