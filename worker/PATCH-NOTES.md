# `_worker.js` 的四处改动（预热池接线）

上游 `_src/cmliu_edgetunnel/_worker.js` **不在仓库里**（`.gitignore` 的 `_src/` 只放本地比对用的源码），所以这里记录把它接上预热池需要动的四段，方便换机或重新拉上游后照着重放。

前提：`worker/sstp-pool/` 已在仓库里；`node scripts/build-worker.mjs` 会把 `sstp.js` + `warm.js` 拼成 `logs/build/sstp-pool.js`（单模块），再由 `scripts/deploy-pages-edge.mjs` 把 `worker.pool.js` 与它一起放进 Pages 的 stage 目录上传。

## 1. 文件第一行：加一条 import（用标记包住，方便出「无池」版）

```js
/*<<WARM_POOL_IMPORT>>*/ import { sstpAcquire } from './sstp-pool.js'; /*<</WARM_POOL_IMPORT>>*/
const Version = '...';
```

`scripts/build-worker.mjs --only=plain` 会把这两个标记之间的内容整段剥掉，产出不预热的回退版。

## 2. `export default { async fetch(request, env, ctx) {` 开头：把 env / ctx 存到模块作用域

```js
async fetch(request, env, ctx) {
    预热池环境 = env;   // forwardataTCP 拿不到 env
    预热池上下文 = ctx; // 补水走 ctx.waitUntil
    let 请求URL文本 = request.url...
```

## 3. `sstpConnect` 之前：插入池子胶水

```js
let 预热池环境 = null;
let 预热池上下文 = null;

function 组装SSTP节点串(proxy) { /* sstp://user:pass@host:port，仅用于日志/键 */ }

async function sstpConnectWithWarmPool(proxy, targetHost, targetPort, TCP连接) {
    const 环境 = 预热池环境;
    const 开关 = 环境 ? String(环境.WARM_POOL ?? '1') !== '0' : false;
    const 池大小 = 环境 ? Number(环境.WARM_POOL_SIZE ?? 2) : 2;
    if (开关 && 池大小 > 0 && typeof sstpAcquire === 'function') {
        try {
            const 结果 = await sstpAcquire(proxy, targetHost, targetPort, {
                connect: TCP连接, log, ctx: 预热池上下文, size: 池大小,
                idleTtlMs: 环境 ? Number(环境.WARM_POOL_TTL || 0) || undefined : undefined
            });
            if (结果?.socket) return 结果.socket;
        } catch (e) { log(`[预热池] 取用失败，回落冷启动: ${e.message || e}`); }
    }
    return sstpConnect(proxy, targetHost, targetPort, TCP连接);
}
```

`typeof sstpAcquire === 'function'` 是为了让 `--plain` 版（import 已被剥掉）也能跑而不抛 `ReferenceError`。

## 4. `forwardataTCP` 里的调用点

```js
} else if (ctx代理类型 === 'sstp') {
    log(`[SSTP代理] 代理到: ${host}:${portNum}`);
    newSocket = await sstpConnectWithWarmPool(ctx代理参数, host, portNum, TCP连接);  // ← 原来是 sstpConnect
```

**关键**：`TCP连接` 就是 `connect` 函数本身（`connect()` 是从调用链上传进来的，workerd 里没有全局 `connect`），必须原样透传给 `openTunnel(proxy, {connect: TCP连接})`。

## 验证

```bash
node scripts/build-worker.mjs                  # 三个产物
node --check logs/build/worker.pool.js         # 语法
node --check logs/build/sstp-pool.js
node test/warm-node.mjs --size 3               # 真实节点冷/热对照（需 SHIM_PROXY + NODE_USE_ENV_PROXY）
cd logs/edge-deploy && wrangler pages functions build --outdir=../edge-bundle   # 验证 Pages 能打包这个 import
```