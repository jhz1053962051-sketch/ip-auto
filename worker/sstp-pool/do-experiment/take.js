/**
 * 边缘侧取用预热隧道的唯一入口（被 _worker.js 动态 import）。
 *
 * 返回与 connect() 同形状的 {readable, writable, close}，可直接塞给 vless 的转发循环；
 * 拿不到就返回 null，调用方回落到原来的 sstpConnect（冷启动）。
 *
 * 双向流走 DO 的 fetch：请求体是上行字节，响应体是下行字节。
 */

function stubFor(env, name = 'sstp-pool') {
	const id = env.SSTP_POOL.idFromName(name);
	return env.SSTP_POOL.get(id);
}

/** 把某个节点登记进池子并开始预热。失败静默（不影响主流程）。 */
export async function warmNode(env, node, size = 3) {
	if (!env?.SSTP_POOL || !node) return false;
	try {
		const stub = stubFor(env);
		await stub.fetch(new Request('https://pool/warm', {
			method: 'POST',
			body: JSON.stringify({ proxy: node, size }),
			headers: { 'content-type': 'application/json' }
		}));
		return true;
	} catch (error) {
		return false;
	}
}

/**
 * 取一条隧道并在隧道内连接 host:port。
 * @returns {Promise<{readable: ReadableStream, writable: WritableStream, close: () => void, warm: boolean, setupMs: number} | null>}
 */
export async function takeWarmTunnel(env, { node, host, port, budgetMs = 9000 }) {
	if (!env?.SSTP_POOL || !node || !host) return null;
	const stub = stubFor(env);
	const url = `https://pool/take?node=${encodeURIComponent(node)}&host=${encodeURIComponent(host)}&port=${Number(port) || 80}&budget=${Number(budgetMs) || 9000}`;

	const { readable, writable } = new TransformStream();
	let response;
	try {
		response = await stub.fetch(new Request(url, { method: 'POST', body: readable }));
	} catch (error) {
		try { await writable.abort(error); } catch (e) { }
		return null;
	}
	if (response.status !== 200 || !response.body) {
		try { await writable.abort(); } catch (e) { }
		try { await response.body?.cancel?.(); } catch (e) { }
		return null;
	}
	return {
		readable: response.body,
		writable,
		warm: response.headers.get('x-sstp-warm') === '1',
		setupMs: Number(response.headers.get('x-sstp-setup-ms')) || 0,
		close() {
			try { writable.abort?.('close')?.catch?.(() => { }); } catch (e) { }
			try { response.body?.cancel?.()?.catch?.(() => { }); } catch (e) { }
		}
	};
}

/** 池子状态（自检/后台用） */
export async function poolStats(env, name = 'sstp-pool') {
	if (!env?.SSTP_POOL) return null;
	try {
		const stub = stubFor(env, name);
		const response = await stub.fetch(new Request('https://pool/stats'));
		return await response.json();
	} catch (error) {
		return { error: error.message };
	}
}