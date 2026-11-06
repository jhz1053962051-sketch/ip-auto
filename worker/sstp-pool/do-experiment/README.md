# Durable Object 版（未采用，留档）

这里放的是最初做的 DO 版预热池（`SstpPool` 类 + `take.js` 通过 `stub.fetch()` 双向流取隧道 + `wrangler.toml`）。

**为什么没上线**：Pages Functions 不支持 Durable Object 绑定，而线上入口是 `ipauto-edge.pages.dev`（`*.workers.dev` 在本网络被 SNI 阻断）。改用 `../warm.js` 的模块级池，效果在同进程实测里一样（冷 1841ms → 热 227ms）。

**什么情况下值得回来用**：有了自定义域名 + Workers 付费计划（DO 需要 $5/mo），并且想要「跨 isolate 共享隧道」。DO 版的好处是隧道不再依赖 isolate 复用，命中率稳定；代价是每次取用多一跳 `stub.fetch()`。

文件：
- `pool.js` —— DO 类，`POST /warm` 登记节点、`GET /stats`、`POST /take` 取隧道
- `take.js` —— 边缘侧 `warmNode()` / `takeWarmTunnel()` / `poolStats()`
- `index.js` + `wrangler.toml` —— 本地试验入口
