/**
 * cloudflare:sockets 的本地替身
 *
 * 目的：把 cloudflare/check-worker.js 原样跑在本机，验证 Worker 版的
 * SSTP 握手、PPP 协商、隧道内 TCP 是否真的能打通 —— 而不是只做语法检查。
 *
 * 实现方式：用 node:net + node:tls（经本机代理）建真实连接，
 * 再包成 Web Streams 的 readable / writable，形状与 Workers 运行时一致。
 */
import { connectTcp, tlsUpgrade, parseProxy } from '../src/http.mjs';

const PROXY_RAW = process.env.IP_AUTO_PROXY ?? 'http://127.0.0.1:7897';
const proxy = PROXY_RAW ? parseProxy(PROXY_RAW) : null;

export function connect(address, options = {}) {
  const { hostname, port } = address;
  const secure = options.secureTransport === 'on';

  let socket = null;
  const opened = (async () => {
    const raw = await connectTcp(hostname, port, proxy, 20000);
    socket = secure ? await tlsUpgrade(raw, hostname, 20000) : raw;
    // error 必须早绑定，否则响应后再次 error 会变成进程级 unhandled exception
    socket.on('error', () => {});
    return undefined;
  })();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        await opened;
      } catch (e) {
        controller.error(e);
        return;
      }
      socket.on('data', (d) => {
        try { controller.enqueue(new Uint8Array(d)); } catch {}
      });
      socket.on('end', () => { try { controller.close(); } catch {} });
      socket.on('close', () => { try { controller.close(); } catch {} });
      socket.on('error', (e) => { try { controller.error(e); } catch {} });
    },
    cancel() { try { socket?.destroy(); } catch {} },
  });

  const writable = new WritableStream({
    async write(chunk) {
      await opened;
      const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      await new Promise((resolve, reject) => {
        socket.write(buf, (err) => (err ? reject(err) : resolve()));
      });
    },
    async close() {
      await opened.catch(() => {});
      try { socket?.end(); } catch {}
    },
    abort() { try { socket?.destroy(); } catch {} },
  });

  return {
    opened,
    readable,
    writable,
    close: async () => { try { socket?.destroy(); } catch {} },
  };
}
