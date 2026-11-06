/**
 * SSTP 会话（可预热）——从 _src/cmliu_edgetunnel/_worker.js 的 sstpConnect 拆出来的两段式实现。
 *
 * 为什么拆：原 sstpConnect(proxy, host, port) 是「建隧道 + 隧道内 TCP 连接」一口气做完，
 * 客户端一个字节都没发出去之前已经干等了 1.0~2.5s（TLS → SSTP_DUPLEX_POST → PPP LCP/PAP/IPCP）。
 * 这段成本与目标地址无关，完全可以提前做掉。拆成：
 *
 *   openTunnel(proxy)            → 隧道 + PPP 已就绪，拿到内网 IP（缓存在池子里）
 *   session.dial(host, port)     → 隧道内 TCP 三次握手（只剩 1 个 RTT + 一次 DoH 解析）
 *
 * 语义与原实现保持一致：dial() 返回 {readable, writable, closed, close}，
 * writable 写入的数据会被切包（MSS 1400）封装成 TCP 段发进隧道。
 *
 * 注意：PPP 会话是「一次一个 TCP 连接」的（内网 IP + 单一五元组），
 * 因此一条预热隧道只能服务一个客户端连接，用完即弃 —— 池子要按并发量补水。
 */

const tEncoder = new TextEncoder();
const tDecoder = new TextDecoder();

export const SSTP_TCP_MSS = 1400;
const EMPTY = new Uint8Array(0);
export const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

function u16(bytes, offset = 0) { return (bytes[offset] << 8) | bytes[offset + 1]; }
function u32(bytes, offset = 0) {
	return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}
function randomU16() { return u16(crypto.getRandomValues(new Uint8Array(2))); }

function internetChecksum(bytes, offset, length) {
	let sum = 0;
	for (let index = offset; index < offset + length - 1; index += 2) sum += u16(bytes, index);
	if (length % 2) sum += bytes[offset + length - 1] << 8;
	while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
	return ~sum & 0xffff;
}

function toBytes(data) {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return new Uint8Array(data);
}

function concatBytes(...chunks) {
	const parts = chunks.filter(Boolean).map(toBytes);
	const total = parts.reduce((size, part) => size + part.byteLength, 0);
	if (parts.length === 1) return parts[0];
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
	return out;
}

function withTimeout(promise, ms, message) {
	let timer;
	return Promise.race([
		Promise.resolve(promise).finally(() => clearTimeout(timer)),
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
	]);
}

export function isIPv4(host) {
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
	return host.split('.').every((part) => Number(part) <= 255);
}

export function stripBrackets(host) {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** DoH 解析 A 记录。Worker 里不能用系统 DNS，只能走 HTTPS 查询。 */
export async function resolveA(host, { timeoutMs = 5000 } = {}) {
	const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`;
	const response = await withTimeout(fetch(url, { headers: { accept: 'application/dns-json' } }), timeoutMs, `DoH timeout: ${host}`);
	if (!response.ok) throw new Error(`DoH HTTP ${response.status}: ${host}`);
	const json = await response.json();
	const record = (json.Answer || []).find((item) => item.type === 1 && isIPv4(item.data));
	if (!record) throw new Error(`DoH 无 A 记录: ${host}`);
	return record.data;
}

/**
 * 建隧道 + 完成 PPP 协商（LCP → PAP → IPCP），返回可反复 dial 的会话对象。
 * @param {{hostname: string, port: number|string, username?: string|null, password?: string|null}} proxy
 */
export async function openTunnel(proxy, options = {}) {
	const timeoutMs = Number(options.timeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS;
	const log = options.log || (() => { });
	const tcpConnect = options.connect || ((...args) => connect(...args));

	let bufferedBytes = EMPTY;
	let pppIdentifier = 1;
	let socket = null;
	let reader = null;
	let writer = null;
	let closedSettled = false;
	let currentConn = null;

	const readSocketChunk = async () => {
		const { value, done } = await reader.read();
		if (done || !value) throw new Error('SSTP socket closed');
		return toBytes(value);
	};
	const readBytes = async (length) => {
		while (bufferedBytes.byteLength < length) {
			const chunk = await readSocketChunk();
			bufferedBytes = bufferedBytes.byteLength ? concatBytes(bufferedBytes, chunk) : chunk;
		}
		const result = bufferedBytes.subarray(0, length);
		bufferedBytes = bufferedBytes.subarray(length);
		return result;
	};
	const readHttpLine = async () => {
		for (; ;) {
			const lineEnd = bufferedBytes.indexOf(10);
			if (lineEnd >= 0) {
				const line = tDecoder.decode(bufferedBytes.subarray(0, lineEnd));
				bufferedBytes = bufferedBytes.subarray(lineEnd + 1);
				return line.replace(/\r$/, '');
			}
			const chunk = await readSocketChunk();
			bufferedBytes = bufferedBytes.byteLength ? concatBytes(bufferedBytes, chunk) : chunk;
		}
	};
	const readPacket = async (budget = timeoutMs) => {
		const header = await withTimeout(readBytes(4), budget, 'SSTP read timeout');
		const length = u16(header, 2) & 0x0fff;
		if (length < 4) throw new Error('Invalid SSTP packet length');
		return {
			isControl: (header[1] & 1) !== 0,
			body: length > 4 ? await withTimeout(readBytes(length - 4), budget, 'SSTP packet body read timeout') : EMPTY
		};
	};
	const buildDataPacket = (pppFrame) => {
		const length = 6 + pppFrame.byteLength;
		const packet = new Uint8Array(length);
		packet.set([0x10, 0x00, ((length >> 8) & 0x0f) | 0x80, length & 0xff, 0xff, 0x03]);
		packet.set(pppFrame, 6);
		return packet;
	};
	const buildConfigurePacket = (protocol, code, id, options = []) => {
		const optionsLength = options.reduce((size, option) => size + 2 + option.data.byteLength, 0);
		const frame = new Uint8Array(6 + optionsLength);
		const view = new DataView(frame.buffer);
		view.setUint16(0, protocol);
		frame[2] = code;
		frame[3] = id;
		view.setUint16(4, 4 + optionsLength);
		options.reduce((offset, option) => {
			frame[offset] = option.type;
			frame[offset + 1] = 2 + option.data.byteLength;
			frame.set(option.data, offset + 2);
			return offset + 2 + option.data.byteLength;
		}, 6);
		return frame;
	};
	const parsePPP = (data) => {
		const offset = data.byteLength >= 2 && data[0] === 0xff && data[1] === 0x03 ? 2 : 0;
		if (data.byteLength - offset < 4) return null;
		const protocol = u16(data, offset);
		if (protocol === 0x0021) return { protocol, ipPacket: data.subarray(offset + 2) };
		if (data.byteLength - offset < 6) return null;
		return { protocol, code: data[offset + 2], id: data[offset + 3], payload: data.subarray(offset + 6), rawPacket: data.subarray(offset) };
	};
	const parseOptions = (data) => {
		const options = [];
		for (let offset = 0; offset + 2 <= data.byteLength;) {
			const type = data[offset];
			const length = data[offset + 1];
			if (length < 2 || offset + length > data.byteLength) break;
			options.push({ type, data: data.subarray(offset + 2, offset + length) });
			offset += length;
		}
		return options;
	};

	const close = (reason) => {
		// 注意：不能在这里回调 currentConn.close —— 那个 close 就是本函数，会无限递归。
		try { reader?.cancel?.().catch?.(() => { }); } catch (e) { }
		try { reader?.releaseLock?.(); } catch (e) { }
		try { writer?.close?.().catch?.(() => { }); } catch (e) { }
		try { writer?.releaseLock?.(); } catch (e) { }
		try { socket?.close?.(); } catch (e) { }
		if (!closedSettled) closedSettled = true;
		if (reason) log(`[sstp] 关闭: ${reason}`);
	};

	try {
		const serverHost = stripBrackets(proxy.hostname);
		const serverPort = Number(proxy.port) || 443;
		socket = tcpConnect({ hostname: serverHost, port: serverPort }, { secureTransport: 'on', allowHalfOpen: false });
		await withTimeout(socket.opened, timeoutMs, 'SSTP server connection timed out');
		reader = socket.readable.getReader();
		writer = socket.writable.getWriter();

		const displayHost = serverHost.includes(':') ? `[${serverHost}]` : serverHost;
		const httpRequest = tEncoder.encode(
			'SSTP_DUPLEX_POST /sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/ HTTP/1.1\r\n'
			+ `Host: ${serverPort === 443 ? displayHost : `${displayHost}:${serverPort}`}\r\n`
			+ 'Content-Length: 18446744073709551615\r\n'
			+ `SSTPCORRELATIONID: {${crypto.randomUUID()}}\r\n\r\n`
		);
		const encapsulatedProtocol = new Uint8Array(2);
		new DataView(encapsulatedProtocol.buffer).setUint16(0, 1);
		const maximumReceiveUnit = new Uint8Array(2);
		new DataView(maximumReceiveUnit.buffer).setUint16(0, 1500);
		const connectRequest = new Uint8Array(12 + encapsulatedProtocol.byteLength);
		const connectView = new DataView(connectRequest.buffer);
		connectRequest[0] = 0x10;
		connectRequest[1] = 0x01;
		connectView.setUint16(2, connectRequest.byteLength | 0x8000);
		connectView.setUint16(4, 0x0001);
		connectView.setUint16(6, 1);
		connectRequest[9] = 1;
		connectView.setUint16(10, 4 + encapsulatedProtocol.byteLength);
		connectRequest.set(encapsulatedProtocol, 12);

		await withTimeout(writer.write(concatBytes(
			httpRequest,
			connectRequest,
			buildDataPacket(buildConfigurePacket(0xc021, 1, pppIdentifier++, [{ type: 1, data: maximumReceiveUnit }]))
		)), timeoutMs, 'SSTP HTTP handshake request timed out');

		const statusLine = await withTimeout(readHttpLine(), timeoutMs, 'SSTP HTTP handshake timed out');
		for (; ;) {
			const line = await withTimeout(readHttpLine(), timeoutMs, 'SSTP HTTP header read timed out');
			if (line === '') break;
		}
		if (!/HTTP\/\d(?:\.\d)?\s+2\d\d/i.test(statusLine)) throw new Error(`SSTP HTTP handshake failed: ${statusLine || 'invalid status'}`);

		let localLcpAcked = false, peerLcpAcked = false, papRequired = false, papSent = false, papDone = false, ipcpStarted = false, ipcpFinished = false;
		let sourceIp = null;
		const sendPapIfReady = async () => {
			if (!localLcpAcked || !peerLcpAcked || !papRequired || papSent) return;
			if (proxy.username == null || proxy.password == null) throw new Error('SSTP server requires PAP authentication');
			const username = tEncoder.encode(proxy.username);
			const password = tEncoder.encode(proxy.password);
			if (username.byteLength > 255 || password.byteLength > 255) throw new Error('SSTP username/password is too long');
			const papLength = 6 + username.byteLength + password.byteLength;
			const frame = new Uint8Array(2 + papLength);
			const view = new DataView(frame.buffer);
			view.setUint16(0, 0xc023);
			frame[2] = 1;
			frame[3] = pppIdentifier++;
			view.setUint16(4, papLength);
			frame[6] = username.byteLength;
			frame.set(username, 7);
			frame[7 + username.byteLength] = password.byteLength;
			frame.set(password, 8 + username.byteLength);
			await withTimeout(writer.write(buildDataPacket(frame)), timeoutMs, 'SSTP PAP authentication request timed out');
			papSent = true;
		};
		const startIpcpIfReady = async () => {
			if (!localLcpAcked || !peerLcpAcked || ipcpStarted || (papRequired && !papDone)) return;
			await withTimeout(writer.write(buildDataPacket(buildConfigurePacket(0x8021, 1, pppIdentifier++, [
				{ type: 3, data: new Uint8Array(4) }
			]))), timeoutMs, 'SSTP IPCP request timed out');
			ipcpStarted = true;
		};

		for (let round = 0; round < 50 && !ipcpFinished; round++) {
			const packet = await readPacket();
			if (packet.isControl) continue;
			const ppp = parsePPP(packet.body);
			if (!ppp) continue;

			if (ppp.protocol === 0xc021) {
				if (ppp.code === 1) {
					const authOption = parseOptions(ppp.payload).find((option) => option.type === 3);
					if (authOption?.data?.byteLength >= 2) {
						const authProtocol = u16(authOption.data);
						if (authProtocol !== 0xc023) throw new Error(`SSTP unsupported PPP auth protocol: 0x${authProtocol.toString(16)}`);
						papRequired = true;
					}
					const ack = new Uint8Array(ppp.rawPacket);
					ack[2] = 2;
					await withTimeout(writer.write(buildDataPacket(ack)), timeoutMs, 'SSTP LCP Configure-Ack timed out');
					peerLcpAcked = true;
					await sendPapIfReady();
					await startIpcpIfReady();
				} else if (ppp.code === 2) {
					localLcpAcked = true;
					await sendPapIfReady();
					await startIpcpIfReady();
				}
				continue;
			}

			if (ppp.protocol === 0xc023) {
				if (ppp.code === 2) { papDone = true; await startIpcpIfReady(); }
				else if (ppp.code === 3) throw new Error('SSTP PAP authentication failed');
				continue;
			}

			if (ppp.protocol === 0x8021) {
				if (ppp.code === 1) {
					const ack = new Uint8Array(ppp.rawPacket);
					ack[2] = 2;
					await withTimeout(writer.write(buildDataPacket(ack)), timeoutMs, 'SSTP IPCP Configure-Ack timed out');
					await startIpcpIfReady();
				} else if (ppp.code === 3) {
					const addressOption = parseOptions(ppp.payload).find((option) => option.type === 3);
					if (addressOption?.data?.byteLength === 4) {
						sourceIp = [...addressOption.data].join('.');
						await withTimeout(writer.write(buildDataPacket(buildConfigurePacket(0x8021, 1, pppIdentifier++, [
							{ type: 3, data: addressOption.data }
						]))), timeoutMs, 'SSTP IPCP address request timed out');
						ipcpStarted = true;
					}
				} else if (ppp.code === 2) {
					const addressOption = parseOptions(ppp.payload).find((option) => option.type === 3);
					if (addressOption?.data?.byteLength === 4) sourceIp = [...addressOption.data].join('.');
					ipcpFinished = true;
				}
			}
		}
		if (!sourceIp) throw new Error('SSTP did not assign an IPv4 address');
		log(`[sstp] 隧道就绪 ${serverHost}:${serverPort} 内网 ${sourceIp}`);

		/** 隧道内建立一条 TCP 连接，返回与 socket 同形状的 {readable, writable, closed, close} */
		const dial = async (targetHost, targetPort, dialOptions = {}) => {
			const budget = Number(dialOptions.timeoutMs) || timeoutMs;
			const target = stripBrackets(targetHost);
			let targetIp = isIPv4(target) ? target : null;
			if (!targetIp) targetIp = await resolveA(target, { timeoutMs: 5000 });

			const sourcePort = 10000 + (randomU16() % 50000);
			const sourceAddress = new Uint8Array(String(sourceIp).split('.').map(Number));
			const destinationAddress = new Uint8Array(String(targetIp).split('.').map(Number));
			let sequenceNumber = u32(crypto.getRandomValues(new Uint8Array(4)));
			let acknowledgementNumber = 0;
			const ipHeaderTemplate = new Uint8Array(20);
			ipHeaderTemplate.set([0x45, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 64, 6]);
			ipHeaderTemplate.set(sourceAddress, 12);
			ipHeaderTemplate.set(destinationAddress, 16);
			const pseudoHeader = new Uint8Array(1432);
			pseudoHeader.set(sourceAddress);
			pseudoHeader.set(destinationAddress, 4);
			pseudoHeader[9] = 6;

			const buildTcpFrame = (flags, payload = EMPTY) => {
				const bytes = toBytes(payload);
				const payloadLength = bytes.byteLength;
				const tcpLength = 20 + payloadLength;
				const ipLength = 20 + tcpLength;
				const sstpLength = 8 + ipLength;
				const frame = new Uint8Array(sstpLength);
				const view = new DataView(frame.buffer);
				frame.set([0x10, 0x00, ((sstpLength >> 8) & 0x0f) | 0x80, sstpLength & 0xff, 0xff, 0x03, 0x00, 0x21]);
				frame.set(ipHeaderTemplate, 8);
				view.setUint16(10, ipLength);
				view.setUint16(12, randomU16());
				view.setUint16(18, internetChecksum(frame, 8, 20));
				view.setUint16(28, sourcePort);
				view.setUint16(30, Number(targetPort));
				view.setUint32(32, sequenceNumber);
				view.setUint32(36, acknowledgementNumber);
				frame[40] = 0x50;
				frame[41] = flags;
				view.setUint16(42, 65535);
				if (payloadLength) frame.set(bytes, 48);
				pseudoHeader[10] = tcpLength >> 8;
				pseudoHeader[11] = tcpLength & 0xff;
				pseudoHeader.set(frame.subarray(28, 28 + tcpLength), 12);
				view.setUint16(44, internetChecksum(pseudoHeader, 0, 12 + tcpLength));
				return frame;
			};
			const matchIncoming = (ipPacket) => {
				if (ipPacket.byteLength < 40 || ipPacket[9] !== 6) return null;
				const ipHeaderLength = (ipPacket[0] & 0x0f) * 4;
				if (ipPacket.byteLength < ipHeaderLength + 20) return null;
				if (u16(ipPacket, ipHeaderLength) !== Number(targetPort)) return null;
				if (u16(ipPacket, ipHeaderLength + 2) !== sourcePort) return null;
				return {
					flags: ipPacket[ipHeaderLength + 13],
					sequence: u32(ipPacket, ipHeaderLength + 4),
					payloadOffset: ipHeaderLength + ((ipPacket[ipHeaderLength + 12] >> 4) & 0x0f) * 4
				};
			};

			await withTimeout(writer.write(buildTcpFrame(0x02)), budget, 'SSTP TCP SYN write timed out');
			sequenceNumber = (sequenceNumber + 1) >>> 0;
			let ready = false;
			for (let attempt = 0; attempt < 30; attempt++) {
				const packet = await readPacket(budget);
				if (packet.isControl) continue;
				const ppp = parsePPP(packet.body);
				if (!ppp || ppp.protocol !== 0x0021) continue;
				const tcp = matchIncoming(ppp.ipPacket);
				if (!tcp || (tcp.flags & 0x12) !== 0x12) continue;
				acknowledgementNumber = (tcp.sequence + 1) >>> 0;
				await withTimeout(writer.write(buildTcpFrame(0x10)), budget, 'SSTP TCP ACK write timed out');
				ready = true;
				break;
			}
			if (!ready) throw new Error(`TCP handshake through SSTP timed out: ${target}:${targetPort}`);

			let controller = null;
			const readable = new ReadableStream({
				start(c) { controller = c; },
				cancel() { close('客户端取消读取'); }
			});
			const closed = new Promise((resolve) => { });

			(async () => {
				try {
					let pending = [], pendingLength = 0;
					const flush = () => {
						if (!pendingLength) return;
						if (!controller) throw new Error('SSTP readable stream is not ready');
						controller.enqueue(pending.length === 1 ? pending[0] : concatBytes(...pending));
						pending = [];
						pendingLength = 0;
						writer.write(buildTcpFrame(0x10)).catch(() => { });
					};
					for (; ;) {
						const packet = await readPacket(60000);
						if (packet.isControl) continue;
						const ppp = parsePPP(packet.body);
						if (!ppp || ppp.protocol !== 0x0021) continue;
						const incoming = matchIncoming(ppp.ipPacket);
						if (!incoming) continue;

						if (incoming.payloadOffset < ppp.ipPacket.byteLength) {
							const payload = ppp.ipPacket.subarray(incoming.payloadOffset);
							if (payload.byteLength) {
								acknowledgementNumber = (incoming.sequence + payload.byteLength) >>> 0;
								pending.push(new Uint8Array(payload));
								pendingLength += payload.byteLength;
							}
						}
						if (incoming.flags & 0x01) {
							flush();
							acknowledgementNumber = (acknowledgementNumber + 1) >>> 0;
							writer.write(buildTcpFrame(0x11)).catch(() => { });
							const current = controller;
							if (current) { try { current.close(); } catch (e) { } }
							close('对端 FIN');
							return;
						}
						if (bufferedBytes.byteLength < 4 || pendingLength >= 32768) flush();
					}
				} catch (error) {
					const current = controller;
					if (current) { try { current.error(error); } catch (e) { } }
					close(error.message);
				}
			})();

			const writable = new WritableStream({
				async write(chunk) {
					const bytes = toBytes(chunk);
					if (!bytes.byteLength) return;
					if (bytes.byteLength <= SSTP_TCP_MSS) {
						await writer.write(buildTcpFrame(0x18, bytes));
						sequenceNumber = (sequenceNumber + bytes.byteLength) >>> 0;
						return;
					}
					const frames = [];
					for (let offset = 0; offset < bytes.byteLength; offset += SSTP_TCP_MSS) {
						const segment = bytes.subarray(offset, Math.min(offset + SSTP_TCP_MSS, bytes.byteLength));
						frames.push(buildTcpFrame(0x18, segment));
						sequenceNumber = (sequenceNumber + segment.byteLength) >>> 0;
					}
					await writer.write(concatBytes(...frames));
				},
				close() { return writer.write(buildTcpFrame(0x11)).catch(() => { }); },
				abort() { close('写入中止'); }
			});

			const conn = {
				readable, writable, closed, close: () => close('连接关闭'),
				targetIp, target, sourcePort
			};
			currentConn = conn;
			return conn;
		};

		return {
			sourceIp,
			server: `${serverHost}:${serverPort}`,
			dial,
			close,
			get buffered() { return bufferedBytes.byteLength; }
		};
	} catch (error) {
		close(error.message);
		throw error;
	}
}