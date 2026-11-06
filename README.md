# ip-auto · 住宅 IP 节点 24 小时全自动订阅

参照视频/教程（[blog.imxiaohe.com/2026/10/ipcloudflare.html](https://blog.imxiaohe.com/2026/10/ipcloudflare.html)）复刻并跑通的完整实现：
从 VPN Gate 抓节点 → SSTP 真实握手探测 → 判定住宅/机房 → 生成订阅 → Cloudflare edgetunnel/Pages 套链式代理 → GitHub Actions 每 24 小时自动重跑。

## 已经在线跑着的东西

| 用途 | 地址 | 备注 |
|---|---|---|
| **节点总览（浏览器看这个）** | `https://jhz1053962051-sketch.github.io/ip-auto/` | 每条节点都带「复制 vless」，点一下就能导入；纯静态 0.6s 打开 |
| **订阅链接（喂客户端）** | `https://ipauto-edge.pages.dev/sub?token=2ce8fa81f3da82450905b322ab649142` | 直连可用，不需要任何代理；日本 / 韩国 / 新加坡 三国节点 |
| 订阅（Clash 版） | 同上加 `&clash` | 输出 Clash YAML |
| 后台管理 | `https://ipauto-edge.pages.dev/admin` | 密码不入库，见 `HANDOVER.local.md`（或 `logs/pages-edge.json` 的 `admin` 字段） |
| 检测 Worker（Cloudflare） | `https://ipauto-check-sstp.jhz1053962051.workers.dev` | `/check?sstp=vpn:vpn@HOST:PORT` |
| 节点池（GitHub Pages） | `https://jhz1053962051-sketch.github.io/ip-auto/nodes.txt` | edgetunnel 每天从这里取 |
| **直连节点（要快用这个）** | `https://jhz1053962051-sketch.github.io/ip-auto/direct/clash.yaml` | 不经 Cloudflare，http/socks5 直连，比上面那批快 600~700ms；公共池，会失效 |
| **纯净度（欺诈分）** | 就在总览页的「欺诈分」一列 | Scamalytics 分数，0 最干净、100 最脏；住宅 ≠ 干净，详见下文 |
| 仓库 | `https://github.com/jhz1053962051-sketch/ip-auto` | Actions 每天 11:17（北京）跑一轮 |

**浏览器怎么用**：打开「节点总览」页 → 顶部「订阅地址」一行点「复制」→ 粘进 v2rayN / Clash Verge 的订阅栏；
或者直接在表格里点某一条的「复制 vless」只导入那一个节点。总览页顶部还有「打开看原文」，点了就是 `/sub` 的原始文本。

> 订阅地址里的 token 由 `MD5MD5(host + uuid)` 算出来（不是直接 md5），改域名/UUID 后要用
> `node scripts/show-sub.mjs` 重算，否则一直 401。总览页的 token 由流水线自己算，不用手管。

---

## 和教程的三处关键差异

1. **SSTP 端口不能写死 443**。教程里的 `gate` 项目把端口固定为 443，而 VPN Gate 的**真实家宽节点几乎全用随机端口**（1223 / 995 / 1352 / 1591 …）。照教程做只能拿到 `public-vpn-NNN` 机房节点，真家宽会被 100% 误判为不可用。本项目从 OpenVPN 配置的 `remote <ip> <port>` 里读真实端口。
2. **`*.workers.dev` 在部分网络被 SNI 阻断**。实测本机对任何 `*.workers.dev` 的 TLS 握手都是 `ECONNRESET`（换 `Host` 头也没用，CF 按 SNI 路由）。所以真正的入口放在 **Cloudflare Pages**（`*.pages.dev` 可直连），Worker 版本保留作备用。
3. **订阅 token 不是简单 md5**。edgetunnel 用的是 `MD5MD5(t) = md5(md5(t).slice(7,27))`，自己改域名后算不出来会一直 401，脚本 `scripts/edgetunnel-setup.mjs` 会直接打印正确 token。
4. **VPN Gate 根本没有新加坡**。抓全量 CSV 也只有 JP / KR / RU / VN / TH / US / TW / RO 这些国家，`grep ',SG,'` 零命中。所以新加坡走的是**另一条支线**：公共代理池 + edgetunnel 的 http 链式代理（`$http://host:port`）。代价是新加坡节点只能是机房 IP（详见下节）。

### 新加坡这条支线为什么只能是机房

VPN Gate 不给新加坡，只能从公开代理池捞。实测结果（`node src/run.mjs --countries SG`）：

```
候选 115 条 → 探测组合 230 个（http + socks5 各试一遍）→ 存活 1~12 → 出口在新加坡的 1~11 → 住宅 0
```

公共池里的新加坡 IP 几乎全是云厂商：腾讯云（`43.156.x.x` / `129.226.x.x`）、阿里云（`8.219.x.x`）、Azure（`20.44.x.x`）、Contabo（`103.164.54.x`）。ip-api 一律 `hosting:true`。
所以订阅里新加坡节点的名字是 **`新加坡-机房-NN`**，日韩仍是 `日本-住宅-NN` / `韩国-住宅-NN` —— 名字里就是判定结果，不会混。

**探针路径必须和 Worker 完全一致**，这是这条支线上唯一的坑：

| 探针写法 | 结果 |
|---|---|
| `GET http://ip-api.com/...`（absolute-form，80 端口） | **假阳性**，本地通过但线上 Worker 报 `Connection failed: HTTP 404` |
| `CONNECT ip-api.com:80` | **误杀好代理**，公共代理普遍只放行 CONNECT 到 443，403/404 一片 |
| `CONNECT cloudflare.com:443` → TLS → `GET /cdn-cgi/trace` | ✅ 与线上 `/admin/check` 走同一条路，判定一致 |

`src/proxycheck.mjs` 用的是第三种，文件头注释里写着前两种为什么不行。

### 延迟：先说结论，再说之前为什么量错了

**真实全链路 TTFB：1.2~5.0s，中位约 3.3s，最好 1.2s。** 最近一轮本机实测 77 个节点，52 个通过（另外 25 个要么连不上、要么出口不是预期国家，已从产物里摘掉），`real_ms` 分布：`p10 2061 / p50 3294 / p90 4976`，最快是新加坡机房 `1207ms`，日本住宅最快 `1749ms`。

这个数字不好看，但它是真的。之前两版结论（先「2.2~3.0s 地板」，后「195~900ms、中位 431ms」）都是**尺子坏了**测出来的 —— 详见下两节。现在这个数是用进程内 SOCKS5 自己握手、并且校验出口国家换来的。

#### 为什么是秒级：SSTP 建链在首包时才发生

链路是「浏览器 → CF colo → Worker → SSTP 节点 → 目标站」。客户端连上 CF、发 TLS ClientHello 之后，Worker 才**开始**向 SSTP 服务器拨号：TLS 握手 → `SSTP_DUPLEX_POST` 升级 → `CALL_CONNECT_REQUEST` → PPP 的 LCP/PAP/IPCP 协商 → 隧道内再 TCP 握手。这一串 `1.0~2.5s` 全部落在客户端感知的「TLS 握手」时间里，**每条新连接都要付一次**（HTTP keep-alive 之后同一连接上的后续请求才是毫秒级）。

所以 `real_ms ≈ 隧道建链(1.0~2.5s) + 传输(0.1~0.5s)`。机房节点比住宅节点快，是因为它们的 SSTP 服务端离 CF colo 更近、PPP 收敛更快 —— 这不是「住宅 IP 天生慢」，而是「不同的 SSTP 服务端协商速度不同」。

#### 三个「延迟」数字，含义完全不同

| 字段 | 量的是什么 | 典型值 | 能不能当延迟用 |
|---|---|---|---|
| `latency_ms` | 建链总耗时：DoH 解析 + SSTP TLS 握手 + PPP(LCP/PAP/IPCP) 协商 + 隧道内 TCP 握手 + HTTP 往返 | 1.9~10s | ❌ 完全不能 |
| `worker_ms` | Worker 到节点那一段（`/admin/check` 返回），**不含「浏览器 → CF colo」和 CF 的 TLS** | 200~6000ms | ⚠️ 只能粗排 |
| `real_ms` | 真客户端全链路 TTFB：浏览器 → CF colo → Worker → 节点 → 目标站 | **1.2~5.0s（中位 3.3s）** | ✅ 唯一代表体感，排序主键 |

#### 之前两次量错，错在哪

**第一次（2.2~3.0s 地板）**：`scripts/measure-real.mjs` 把 N 个 vless outbound 塞进**同一个 Xray 进程**，共用同一个 UUID —— 出站互相踢连接，头几个直接 FAIL、后面的数字乱跳（同一节点既像 1411ms 也可能 17751ms）。改成**每节点独立 spawn 一个 Xray 进程**后这一项修好了。

**第二次（195~900ms、中位 431ms）**：修好进程隔离之后数字变得很好看，但那是**假的** —— 因为测延迟还在 `execFileSync('curl', ['--socks5-hostname', ...])`。某些受管环境里的 `curl.exe` 会被外层拦截层接管，**`-x` / `--socks5-hostname` 被静默忽略**：

```bash
# 端口 9 上没有任何程序监听，真 curl 必然报 "Could not connect to server"
$ curl --socks5-hostname 127.0.0.1:9 https://cloudflare.com/cdn-cgi/trace
ip=118.212.159.40        # ← 照样返回 200，说明它根本没走 socks
loc=CN
```

于是「隧道延迟」量到的其实是拦截层自己那条路的延迟。判据还有一条：把 Xray 出站改成 `blackhole`（`logs/xray-blackhole.json`），curl 依然返回 200。

**现在**：`src/socksprobe.mjs` 在 Node 进程里自己完成 SOCKS5 握手 + TLS + HTTP，`src/realmeas.mjs` 用它探 `cloudflare.com/cdn-cgi/trace`，**顺带校验 `loc` 必须等于节点名里的国家**（日本→JP / 韩国→KR / 新加坡→SG）—— 出口跑偏或 Worker 回落直连的节点一律判 FAIL，不许冒充「可用」。

#### 现在做的事

1. **`real_ms` 是排序主键**。`src/edges.mjs` 的 `sortLatency()` 优先取 `real_ms`，没有实测值的退回 `worker_ms + 1000`，再退回 `latency_ms + 5000` —— 没测过的排在后面，而不是冒充最快。
2. **排序全局化**。以前是「按国家分组 → 住宅整体前置」，400ms 的机房节点会排在 1800ms 的住宅后面。现在先给节点起名字，再把全部节点混在一起按 `real_ms` 排 —— 打开订阅第一个就是实测最快的那个。
3. **实测进流水线**（`src/realmeas.mjs` + `src/run.mjs` 的「7.5) 实测客户端真实延迟」段）：探测 → Worker 排名 → 实测 → 按实测重排 `nodes.txt` / 订阅 / 页面。页面统计卡显示「实测延迟中位数（最快 Nms）」，表格里「实测延迟」和「Worker 侧」两列并列。
4. **入口只留香港 colo**。扫了 35 个 CF anycast IP + 8 个优选域名，`104.26.x.x` 全落 HKG、`104.27.x.x` / `172.66.x.x` 全落 LAX。判据是 **colo 而不是本机 TLS 耗时**：`104.27.0.1` 直连 TLS 只要 179ms（全场最快），但落 LAX。`src/edges.mjs` 现在只有 10 个 HKG IP + 6 个 LAX 域名兜底。
5. **加一条直连支线**（见下节）：http/socks5 代理不经 Cloudflare、也不建 SSTP，实测 250~1100ms，比走 Worker 快 1~2.5s —— 代价是这类代理随时会失效、部分做 TLS 拦截。

#### 试过但走不通的（留档，别重复踩）

| 尝试 | 结果 |
|---|---|
| 开 `启用0RTT` + Xray `maxEarlyData` | 反而更慢（2.2~2.6s vs 基线 1.6~2.0s），已回滚 |
| Xray `mux.cool` 多路复用 | edgetunnel 只认 `cmd=1/2`，没有 mux 分支，全 `appconnect=0.000` |
| 本机直连住宅节点跑原生 SSTP | TCP 三次握手只要 61~209ms，但 **SSTP+PPP 协商本身 3.8~5.6s**，比经 Worker 还慢 |
| 443 端口直连 `public-vpn-NNN` | 7 个里只有 1 个通；随机高端口 28 个里 9 个通 —— 端口 443 被重点干扰 |
| 同时起多个 vless outbound 指向同一 UUID | 除第一个外全部超时（Worker 侧互踢），A/B 与实测**必须**每节点独立进程 |
| `pages.dev` 经本地代理 7897 访问 | `schannel: failed to receive handshake`；必须直连，且要把 SNI 钉到已知 HKG IP（`src/http.mjs` 的 `connectIp`） |
| 用 `curl --socks5-hostname` 测隧道延迟 | 环境里的 curl 被拦截层接管，代理参数被静默忽略（拿端口 9 当代理也返回 200），测出来是拦截层那条路 —— **改用 `src/socksprobe.mjs`** |

**结论**：走 Worker 的节点有 **1.0~2.5s 的隧道建链成本**，这条成本来自 SSTP+PPP 协商本身，改不了（除非做会话预热池：Worker 侧维护一批已建立的 SSTP 会话，来一个请求就发一个，把 1.5s 压到 ~0.1s —— 需要 Durable Object，尚未实现）。在那之前，能立刻见效的只有下面这条直连支线。

### 直连支线：同一条链上唯一能真正省时间的一段

`scripts/make-direct-sub.mjs` 从公共池抓 JP/KR/SG 的 http/socks5 代理，**直连**探测（不经过 7897、不经过 Worker），出口必须在目标国，生成三份产物：

```
public/direct/clash.yaml   Clash / mihomo 订阅（url-test 自动选最快）
public/direct/xray.json    Xray 配置（socks inbound 10800 起，一节点一端口）
public/direct/nodes.txt    人读清单
```

同一批节点的对照：

| 节点 | 直连 | 经 CF + Worker |
|---|---|---|
| `4.144.146.21:80`（SG） | **292ms** | 983ms |
| `8.209.255.13:3128`（JP） | **258ms** | 565ms |

差的这 600~700ms 全是 Cloudflare 那一跳 + Worker 里建链的开销，跟节点本身无关。

**代价要说清楚**（`test/direct-e2e.mjs` 实测，curl 经每个代理打 3 个站）：

| 代理 | gstatic | ipify | youtube |
|---|---|---|---|
| JP 8.209.255.13:3128 | ❌ 证书不受信 | ❌ | ❌ |
| SG 4.144.146.21:80 | ✅ 0.81s | ✅ 0.55s | ❌ Recv failure |
| SG 159.138.84.187:3128 | ✅ 0.27s | ✅ 16.19s | ❌ |
| KR 222.111.130.73:8080 | ❌ 连接失败 | ❌ | ❌ |
| SG 128.199.113.85:9090 | ✅ 2.61s | ✅ 2.31s | ❌ |
| KR 8.213.151.128:3128 | ❌ 证书不受信 | ❌ | ❌ |
| JP 140.238.32.108:3128 | ✅ 1.67s | ✅ 1.80s | ❌ |

→ **`checkProxy` 通过（CONNECT `cloudflare.com:443`）不代表能访问任意站点**：3/7 有 TLS 拦截（`SEC_E_UNTRUSTED_ROOT`），7/7 打不开 YouTube。所以这条线只适合网页/API，不能当唯一出口，也不能承诺看视频。要稳定住宅 IP 还是用上面那批 vless。

`public/direct/` 一轮抓不到节点时**不覆盖上一轮产物** —— 空订阅会让客户端把已有节点全清掉。

### 结构性优化：SSTP 预热池（把 1.8s 的建链挪到请求之前）

秒级延迟的唯一大头是 **SSTP 建链**：客户端连上的第一个字节才触发 `SSTP_DUPLEX_POST` → `CALL_CONNECT_REQUEST` → PPP LCP/PAP/IPCP → 隧道内 TCP，整串 1.0~2.5s 全在等它。

把它拆成两段就能提前做掉：

```
openTunnel(proxy)                  TLS + SSTP 握手 + PPP 协商 → 拿到内网 IP   1.0~2.5s
session.dial(host, port)           隧道内 TCP 三次握手 + 一次 DoH            ~0.2s
```

一条隧道只能服务一个客户端连接（PPP 是单五元组），所以取走即弃、取完立刻补水。

**为什么不用 Durable Object**：Pages Functions 不支持 DO 绑定，而线上入口正是 `ipauto-edge.pages.dev`（`*.workers.dev` 在本网络被 SNI 阻断）。池子因此放在 Worker isolate 的模块作用域里 —— isolate 被复用时，下一个请求就能拿到已经建好的隧道；补水走 `ctx.waitUntil`，不占响应时间。

本机实测（`node test/warm-node.mjs --size 2`，真实日本住宅节点、真实出口校验）：

```
[cold]     setup 1841ms  → HTTP 200 loc=KR ip=222.117.75.200   ← 建链全付
[pool]     2 条隧道预热完成
[take 0]   warm=true setup  469ms → 同一个出口 IP
[take 1]   warm=true setup  227ms → 同一个出口 IP
[take 2]   warm=false setup 1287ms（两条都取完了，冷启动）
```

**上线与回退**

```bash
node scripts/build-worker.mjs            # 生成 logs/build/{worker.pool.js, sstp-pool.js, worker.plain.js}
node scripts/deploy-pages-edge.mjs       # 预热池版（默认，等同 --pool-size 3）
node scripts/deploy-pages-edge.mjs --plain   # 回退版：不带池，行为与上游原版一致
```

Pages 环境变量里可以直接关：`WARM_POOL=0`（或 `WARM_POOL_SIZE=0`），不用重新部署代码。

**如实说的边界**：命中率取决于同一个 isolate 是否被复用、两次连接间隔是否超过 5s（超过就作废重建）。爆发式的一批请求收益最大；隔很久才来一个连接时，等于没受益。这不是"把延迟变成 200ms"的魔法，是把可提前的 1.5s 挪走。

### 纯净度：住宅 ≠ 干净（这一版新增的维度）

项目原来只用 ip-api 的 `hosting` 字段分「住宅 / 机房」，并默认住宅更好。这个假设是错的。

给 64 个节点（60 个不同出口 IP）逐个查 Scamalytics 欺诈分（0 最干净、100 最脏）后交叉验证：

```
住宅 55 个：中位  8 分，脏（≥50）22 个
机房  9 个：中位  1 分，脏（≥50） 1 个
```

**住宅组反而更脏**。最脏的一批全是满分 100，清一色住宅：

```
fraud  名字           运营商                     出口 IP           实测
  100  日本-住宅-01   SOFTBANK Corp             218.131.41.95     2054ms
  100  韩国-住宅-04   -                         112.172.238.220   2321ms
  100  韩国-住宅-05   KT Corporation            59.6.114.202      2353ms
  100  韩国-住宅-06   Kornet                    222.120.20.69     2437ms
  100  韩国-住宅-07   Kornet                    59.14.221.13      2543ms
  100  韩国-住宅-11   Pubnetplus                125.240.231.54    2685ms
  100  日本-住宅-10   Chubu Telecommunications  14.132.109.178    -
  100  日本-住宅-11   Open Computer Network     180.45.106.251    -
```

反过来，最干净的 4 个 0 分**全是机房**：

```
fraud  名字           运营商                     出口 IP           实测
    0  新加坡-机房-01  Microsoft                20.44.210.140     1160ms
    0  日本-机房-01    Alibaba                  8.209.255.13      1252ms
    0  韩国-机房-01    Alibaba                  8.213.151.128     1281ms
    0  新加坡-机房-02  Alibaba                  8.219.64.236      1580ms
```

（住宅里也有干净的：`日本-住宅-13 126.216.249.148`、`日本-住宅-19 211.128.17.88` 都是 0 分。）

原因不复杂：这些「住宅 IP」其实是 SoftEther / 公共 VPN 的**共享出口**，几万人轮着用同一个家宽地址，风控早把它标成代理池；而阿里云、微软这类机房 IP 没被拿去刷东西。**「住宅」只说明归属，不说明干净。**

于是这一版加了两件事：

1. **流水线第 7.7 段查纯净度**（`src/purity.mjs`，数据源 Scamalytics 网页，免 key）。查的是 `real_ip`（真客户端实测到的出口）而不是 `host` —— 走 CF 的节点 `host` 是边缘 IP `104.26.x.x`，拿它查等于查 Cloudflare。
2. **页面加了一列「欺诈分」**（配色：≤24 绿 / 25~49 灰 / 50~74 橙 / ≥75 红），统计卡加「欺诈分中位数（干净 N / 脏 M）」，顶部一段说明。排序仍然是 `real_ms` 优先 —— **只在延迟完全打平时才用欺诈分兜底**，不打乱「低延迟」这个主序。

单独刷新分数（不重跑采集，60 个 IP 约 40 秒）：

```powershell
$env:https_proxy="http://127.0.0.1:7897"
node scripts/apply-purity.mjs      # 查分 → 写回 data.json → 重排 → 重渲染
node test/purity-report.mjs        # 只打报告：最脏 10 / 最干净 10 / 住宅 vs 机房
node test/purity-unit.mjs          # 解析器单测（27 断言，改正则后必跑）
```

**分档口径**（参考文献 fq-book 的说法）：`0~24 干净` / `25~49 一般` / `50~74 可疑` / `75~100 很脏`。分数高不等于连不上，但打开网页十有八九先给你一个验证码。

**为什么要单独认两种句式**：Scamalytics 对「有该 IP 直接观测」和「只有运营商观测」用的是两种句子，后者写作 `IP address X is operated by OP whose web traffic we consider to present a potentially low fraud risk` —— 那个 `low` 讲的是运营商整体，不是这个 IP。第一版只抓第一处 `potentially <b>X</b>`，结果干净 IP 抓不到分数、脏 IP 的 risk 被运营商那句覆盖，全判成 low。现在两条正则分开认，干净页面的分数走 `apply a risk score of 0/100` 那句兜底。

参考：https://github.com/hoochanlon/fq-book 的 `docs/abc/pure.md`（该书无 LICENSE，只借鉴「纯净度这回事」的思路，未复制任何代码）。

---

## 一、已验证的事实（本机实跑，非推测）

**流水线（本地 / GitHub Actions 均跑通）**

```
$ node src/run.mjs --max 80 --concurrency 8
原始 96 条 → SSTP 63 条 → 检测 63 条
成功 47（住宅 47 / 机房 0），失败 16，耗时 39.9s
国家分布：日本 31 / 韩国 16
```

GitHub Actions 那轮（2026-11-05T08:08Z）：`raw_rows 94 → sstp 70 → checked 70 → success 56（住宅 56 / 机房 0）`，Pages 已发布 56 行。

**订阅 + 真实出网（Xray 25.9.11 导入订阅原样跑，全程不挂本机 7897 代理）**

```
$ node test/sub-e2e.mjs --count 8
✅ 日本-住宅-01   2980ms  114.190.204.149  Japan/Tonoharuminami  NTT Communications
✅ 日本-住宅-02   3394ms  150.31.134.200   Japan/Osaka          Internet Initiative Japan
✅ 日本-住宅-03   2698ms  219.100.37.240   Japan/Matsushige     SoftEther
✅ 日本-住宅-07   4810ms  203.153.77.210   Japan/Futago         Netforest
✅ 日本-住宅-08   3571ms  125.195.150.39   Japan/Tokyo          BIGLOBE
直连成功率 8/8，其中住宅 8 / 机房 0

$ node test/sub-e2e.mjs --sub logs/sub-kr.txt --count 5
✅ 韩国-住宅-01  11631ms  1.227.247.57     South Korea/SK Broadband
✅ 韩国-住宅-03  11934ms  175.122.73.80    South Korea/broadNnet
✅ 韩国-住宅-05   7627ms  211.221.198.244  South Korea/Korea Telecom
直连成功率 3/5，其中住宅 3 / 机房 0
```

ip-api 复核这些出口全部 `hosting:false`、`proxy:false`，反向解析是家宽 PTR（如 `p1897019-ipxg06701aobadori.miyagi.ocn.ne.jp`）。

**加新加坡之后（2026-11-05T09:33Z 那轮，GitHub Actions 实跑）**

```
$ node scripts/summary.mjs
原始 97 条 → SSTP 76 条 → 检测 280 条
成功 66（住宅 62 / 机房 4），失败 214
国家分布：日本 41 个（住宅 41） / 韩国 21 个（住宅 21） / 新加坡 4 个（住宅 0）
```

新加坡 4 个节点逐个过 Xray 真出网（入口不同、出口不同，全部 `loc=SG`）：

| 节点 | 入口 | 出口 IP | 组织 |
|---|---|---|---|
| 新加坡-机房-01 | `www.carousell.sg:443` | `43.156.137.7` | Tencent Cloud |
| 新加坡-机房-02 | `op.chinwa.eu.cc:443` | `20.44.210.140` | Microsoft Azure (southeastasia) |
| 新加坡-机房-03 | `www.dbs.com.sg:443` | `8.219.64.236` | Alibaba.com Singapore |
| 新加坡-机房-04 | `www.mfyx.cn:443` | `47.84.179.9` | Zenlayer |

回归验证日韩没被影响：`日本-住宅-01 → 126.71.98.195 loc=JP`、`韩国-住宅-01 → 121.162.237.104 loc=KR`。

**Cloudflare Worker 代码在部署前就被证明可用**（Node 里用 `cloudflare:sockets` 替身真跑）

```
$ node test/run-worker.mjs public-vpn-129.opengw.net 443
HTTP 200  3610ms
{ "success": true, "exit": { "ip": "219.100.37.239", "country": "Japan", ... } }
```

**线上现在就是实测数据（2026-11-05T14:12Z，本机跑完 → publish → deploy-pages）**

```
$ node src/run.mjs --max 80 --concurrency 10        # 本机，带 real_ms
[real] 实测完成：命中 25/25，可测 25/25，中位 429ms，最快 197ms

$ curl https://jhz1053962051-sketch.github.io/ip-auto/data.json
线上 nodes 25   real_ms 覆盖 25/25   median 429ms   min 197ms
前 5：韩国-住宅-01 197ms / 日本-住宅-01 254ms / 日本-住宅-02 375ms
      韩国-住宅-02 376ms / 日本-住宅-03 377ms

$ curl https://jhz1053962051-sketch.github.io/ip-auto/
index=200 62117B 1.28s
实测延迟中位数（最快 197ms）      ← 统计卡
⚡ 直连节点 / 不经 Cloudflare     ← 直连面板（5 个）

$ curl --resolve ipauto-edge.pages.dev:443:104.26.1.10 -H 'user-agent: v2rayN/6.31' .../sub?token=...
sub=200 11764B 2.38s → 25 个 vless 节点
```

这条链能跑通的前提是 `deploy-pages.yml`（只发布仓库现有 `public/`）—— `vpngate.yml` 会重新采集并覆盖产物，CI 测不出 `real_ms`，所以本机推完只能触发前者。

---

## 二、目录结构

```
ip-auto/
├─ src/
│  ├─ http.mjs       无依赖 HTTP 客户端（手写 CONNECT 代理、TLS、响应解析）
│  ├─ sstp.mjs       SSTP / PPP / LCP / PAP / IPCP / PPP 上的 TCP —— 全手写
│  ├─ probe.mjs      单节点探测（DoH 解析 → SSTP 隧道 → 取出口 IP → 严格校验）
│  ├─ vpngate.mjs    VPN Gate 抓取与解析（含真实 SSTP 端口修复 + 截断重试）
│  ├─ proxysrc.mjs   公共代理池数据源（proxifly / proxyscrape v4+v3），给新加坡这类 VPN Gate 没有的国家用
│  ├─ proxycheck.mjs socks5 / http 代理探针（路径与线上 Worker 的 /admin/check 完全一致）
│  ├─ proxynodes.mjs 代理候选 → 探测 → 出口国家校验 → 节点（协议无关）
│  ├─ geo.mjs        出口 IP 归属判定（ip-api 批量 + 关键词兜底）
│  ├─ edges.mjs      入口池（10 个 HKG colo IP + 6 个 LAX 域名兜底）+ nodes.txt 生成 + sortLatency
│  ├─ sub.mjs        订阅 token（MD5MD5）/ vless 链接生成，算法与 Worker 逐字节一致
│  ├─ render.mjs     概览页 HTML（订阅面板 + 直连面板 + 每条节点的复制按钮）
│  ├─ workerrank.mjs 经 Worker 复测延迟（worker_ms），粗排用
│  ├─ realmeas.mjs   每节点独立 Xray 进程实测全链路 TTFB（real_ms），排序主依据
│  ├─ purity.mjs     纯净度：Scamalytics 欺诈分抓取与分档（免 key，并发 4）
│  ├─ secret.mjs     从环境变量 / logs/*.json 找管理员密码、入口域名、UUID
│  └─ run.mjs        主流水线
├─ cloudflare/
│  └─ check-worker.js  可直接粘贴到 CF 后台的单文件检测 Worker（真 SSTP 握手）
├─ worker/
│  ├─ sstp-pool/
│  │  ├─ sstp.js    独立的 openTunnel() + dial()，与 _worker.js 里的 sstpConnect 行为一致
│  │  ├─ warm.js    模块级预热池（isolate 作用域，非 DO）
│  │  └─ do-experiment/  最初做的 Durable Object 版（Pages 不支持绑定，留档未用）
│  └─ PATCH-NOTES.md  _worker.js 接线四处改动（上游源码不入库，换机照此重放）
├─ scripts/
│  ├─ local-worker.mjs    本地检测服务（/check?sstp=...）
│  ├─ serve.mjs           本地静态站点（预览 public/）
│  ├─ schedule.mjs        常驻守护进程（每 N 小时跑一轮）
│  ├─ run-task.cmd        计划任务实际执行的包装脚本
│  ├─ task.mjs            Windows 计划任务安装/删除/查看
│  ├─ deploy-cloudflare.mjs  CF 一键部署（纯 API，Worker 版）
│  ├─ deploy-pages-edge.mjs  CF Pages 一键部署（wrangler 上传，直连版；默认带预热池，--plain 回退）
│  ├─ build-worker.mjs       拼装 sstp-pool 单文件 + 生成 worker.pool.js / worker.plain.js
│  ├─ deploy-github.mjs      GitHub 一键部署（纯 API）
│  ├─ edgetunnel-setup.mjs   登录后台、改成读自己的 nodes.txt、打印订阅地址
│  ├─ show-sub.mjs           只算并打印订阅地址（改域名/UUID 后重算 token）
│  ├─ render-only.mjs        只重渲染 index.html，不重新探测（改样式时秒看效果）
│  ├─ make-xray-node.mjs     从订阅生成 Xray 配置（单节点 / 指定国家 / 指定入口）
│  ├─ make-direct-sub.mjs    直连节点订阅（绕开 Cloudflare，clash.yaml/xray.json/nodes.txt）
│  ├─ rank-by-worker.mjs     只用 Worker 复测一遍延迟（--no-proxy 直连 pages.dev）
│  ├─ measure-real.mjs       命令行入口（已改为委托 src/realmeas.mjs；老版 curl 实现废弃）
│  ├─ apply-measured.mjs     把一次独立实测写回 data.json 并重排/重渲染（--drop-failed 摘除失败节点）
│  ├─ dump-sub.mjs           从本地 data.json 导出订阅文本（避免线上滞后导致索引错位）
│  ├─ apply-real.mjs         按地址精确匹配把实测值写回 data.json
│  ├─ apply-purity.mjs       只刷新纯净度分数并重排/重渲染（不重跑采集，60 个 IP 约 40 秒）
│  ├─ set-gh-secret.mjs      写 GitHub Actions Secret（libsodium crypto_box_seal）
│  ├─ publish.mjs            把带 real_ms 的本机产物推回仓库并触发 Pages 发布
│  └─ summary.mjs            结果摘要
├─ test/
│  ├─ mock-sockets.mjs      cloudflare:sockets 的 Node 替身
│  ├─ run-worker.mjs        在 Node 里直接跑 Worker 代码
│  ├─ edge-entry-check.mjs  入口域名能否承载我们的 SNI
│  ├─ edge-ip-probe.mjs     固定 CF IP × 我们的 SNI
│  ├─ sub-e2e.mjs           订阅端到端成功率（真出网 + 归属核查）
│  ├─ sni-matrix.mjs        本机 SNI 封锁矩阵
│  └─ ...
├─ public/           产物（data.json / nodes.txt / index.html / subscription.txt）
├─ tools/            xray.exe 等本地工具（.gitignore，按需下载）
└─ .github/workflows/
   ├─ vpngate.yml         每天采集 → 探测 → 发 Pages
   └─ deploy-pages.yml    只发布仓库现有 public/（不重新采集，给本机 publish.mjs 用）
```

---

## 三、本地跑（不依赖任何云账号）

```bash
cd C:/Users/J1053/Documents/ip-auto

node src/run.mjs                       # 全量：抓 → 探测 → 生成
node src/run.mjs --countries JP,KR --max 80 --concurrency 8
node src/run.mjs --countries SG --max 1      # 只跑新加坡支线（会跳过 VPN Gate）

node scripts/serve.mjs                 # http://127.0.0.1:8080 预览产物
node scripts/local-worker.mjs          # http://127.0.0.1:8787 检测服务
```

### 24 小时自动更新，二选一

**为什么要有两条线（关键）**

| 跑在哪 | 能做什么 | 不能做什么 |
|---|---|---|
| **GitHub Actions**（每天 11:17 北京时间） | 抓节点、SSTP 探测、判住宅、Worker 复测、发 Pages | **测不出 `real_ms`** —— CI 没有 `tools/xray.exe`，且机房在美区，测出来的数字对中国用户没意义 |
| **本机计划任务**（每天 12:30） | 上面全部 + **真实全链路 TTFB 实测** + 直连节点 + 把带实测的产物推回仓库 | 电脑关机/休眠时不跑 |

两条线的顺序是刻意的：CI 先跑（11:17），本机后跑（12:30）并用 `real_ms` 覆盖。如果反过来，CI 那一轮会把本机的实测数据冲掉，站点又退回按 `worker_ms` 排 —— 而 `worker_ms` 与真实延迟的 Spearman 相关系数只有 **0.075**，等于乱排。

**A. Windows 计划任务（已装好，推荐）**

```bash
node scripts/task.mjs status           # 看下次运行时间 / 上次结果
node scripts/task.mjs install --time 12:30
node scripts/task.mjs remove           # 随时删干净，不留痕
```

计划任务一轮跑三件事（都在 `scripts/run-task.cmd` 里）：

1. `src/run.mjs` —— 采集 + 探测 + Worker 复测 + `real_ms` 实测 + 生成本地产物（**决定返回码**）
2. `scripts/make-direct-sub.mjs` —— 直连节点副线（失败保留上一轮产物，不影响返回码）
3. `scripts/publish.mjs` —— 把产物推回仓库并触发 `deploy-pages.yml` 发布（失败不影响返回码）

> `run-task.cmd` 里有两条踩过的坑，改动时别踩回去：
> - 开头必须 `set "https_proxy="` 等六行清空代理 —— 探测要走直连，经 7897 会让 `pages.dev` 在 TLS 阶段被掐（`schannel: failed to receive handshake`）。
> - 结尾必须单独一行 `exit /b %RC%`。写成 `endlocal & exit /b %RC%` 时，`%RC%` 在**同一行的解析期**就展开了，返回码恒为 0，任务失败了也显示成功。

`scripts/publish.mjs` 需要一个 GitHub token：优先环境变量 `IP_AUTO_GH_TOKEN` / `GH_TOKEN`，其次文件 `logs/gh-token`（`logs/*` 已被 `.gitignore` 忽略，不会入库）。被拒时它会 `fetch` + `reset` 到最新 main 再把本地产物覆盖回来重建提交，**不 force push**。

**B. 常驻守护进程（想在终端里看着它跑）**

```bash
node scripts/schedule.mjs              # 立即跑一轮，之后每 24h（±20min 抖动）
node scripts/schedule.mjs --every 6 --no-initial
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `IP_AUTO_PROXY` | `http://127.0.0.1:7897` | 本机代理；CI 里置空走直连 |
| `IP_AUTO_COUNTRIES` | `JP,KR,SG` | 国家白名单，`all` 不限 |
| `IP_AUTO_PROXY_COUNTRIES` | `SG` | 走公共代理池的国家（VPN Gate 没有这些国家） |
| `IP_AUTO_PROXY_EXTRA` | `JP,KR` | 额外并行抓代理池的国家（与 VPN Gate 并行，取快的机房节点） |
| `IP_AUTO_PROXY_MAX` | `260` | 每个代理池国家最多取多少候选 |
| `IP_AUTO_ADMIN` | 从 `logs/pages-edge.json` 读 | edgetunnel 管理员密码（Worker 复测要用） |
| `IP_AUTO_EDGE_BASE` | `https://ipauto-edge.pages.dev` | edgetunnel 入口，复测与订阅 token 都基于它 |
| `IP_AUTO_RANK_PROXY` | 空（**直连**） | Worker 复测走哪个代理；留空。**pages.dev 经 7897 会 `failed to receive handshake`** |
| `IP_AUTO_WORKER_RANK` | `1` | 是否用 Worker 复测来排序（关掉则退回本地 `latency_ms`） |
| `IP_AUTO_REAL_MEASURE` | `1` | 是否做全链路 TTFB 实测（需要 `tools/xray.exe`；CI 里设 `0`） |
| `IP_AUTO_REAL_LIMIT` | `0` | 只实测前 N 个（0 = 全部）。调试时用 |
| `IP_AUTO_REAL_CONCURRENCY` | `3` | 实测并发（每个节点一个独立 Xray 进程，别开太大） |
| `IP_AUTO_PURITY` | `1` | 是否查纯净度（Scamalytics 欺诈分）；关掉则页面不显示这一列 |
| `IP_AUTO_PURITY_CONCURRENCY` | `4` | 纯净度并发（实测 4 无 429，别超过 8） |
| `IP_AUTO_SITE` | `https://jhz1053962051-sketch.github.io/ip-auto` | 页面里直连面板的链接前缀 |
| `IP_AUTO_DOH_PROXY` | `http://127.0.0.1:7897` | 只给直连支线的 DoH 用；被探测的代理一律直连 |
| `IP_AUTO_MAX_NODES` | `80` | 最多检测多少条 |
| `IP_AUTO_CONCURRENCY` | `6` | 并发探测数 |
| `IP_AUTO_TIMEOUT_MS` | `22000` | 单节点超时 |
| `IP_AUTO_DOH` | `https://dns.google/resolve` | DoH 端点（本机 DNS 对 opengw.net 有污染） |
| `IP_AUTO_EDGE_HOSTS` | 内置实测池 | 自定义入口，逗号分隔，形如 `a.com:443,b.com:443` |

---

## 四、部署到 Cloudflare

教程是在网页手工粘贴代码。这里给一条命令的版本，**只创建自己前缀的资源，不动任何已有 Worker**。

### 1. 拿 API Token

打开 <https://dash.cloudflare.com/profile/api-tokens> → Create Token。

> **别用「自定义令牌」逐项点权限**——那个权限选择器对自动化极不友好（虚拟滚动 + 受控组件，点完不落值）。
> 用 **「API 令牌模板」里的一键模板**，它会自动带出三项权限：`Workers KV Storage:Edit` + `Workers Scripts:Edit` + `Account Settings:Read`，正是这里需要的。

```bash
export CF_API_TOKEN=你的token
node scripts/deploy-cloudflare.mjs --dry-run    # 先看它要做什么
node scripts/deploy-cloudflare.mjs              # Worker 版检测服务 + edgetunnel
```

它会做完：校验 token → 选账号 → 确认 workers.dev 子域 → 建 KV `ipauto-edgetunnel-KV` → 上传 `ipauto-edgetunnel`（绑 KV + 随机 ADMIN 密码）→ 上传 `ipauto-check-sstp` → 自检 → 把地址和密码写进 `logs/cloudflare-deploy.json`。

### 2. Pages 版（直连入口，**推荐**）

`*.workers.dev` 在不少网络被 SNI 阻断，Pages 的 `*.pages.dev` 通常可直连。

```bash
npm i -g wrangler --registry=https://registry.npmmirror.com   # 只用来上传，不用它管配置
node scripts/deploy-pages-edge.mjs
```

它会：建项目 `ipauto-edge` → 绑定 KV 与 `ADMIN`/`UUID`/`HOST` 环境变量 → 用 `wrangler pages deploy` 上传 `_worker.js` → 自检 `/version` `/login` `/sub`。

两个必踩的坑，脚本已经绕过：

- 裸调 Pages deployments API 传 `_worker.js`，服务端**返回 success 但 Functions 不生效**（所有路径空体 404）。必须用 wrangler 上传。
- 项目环境变量缺 `UUID`/`HOST` 时，`_worker.js` 会落进 `!envUUID` 分支去 fetch `https://edt-pages.github.io/noKV`，表现为 404 空体。

### 3. 手动版（不想给 Token）

| 步骤 | 用什么 |
|---|---|
| 检测 Worker | `cloudflare/check-worker.js`（整文件粘贴，单文件零依赖） |
| edgetunnel | `_src/cmliu_edgetunnel/_worker.js`（上游原版，5 MB） |
| edgetunnel 环境变量 | `ADMIN` = 后台密码；Pages 方式再加 `UUID`、`HOST` |
| edgetunnel KV 绑定 | 变量名必须是 `KV` |

---

## 五、部署到 GitHub（24 小时自动跑）

```bash
export GH_TOKEN=ghp_xxxx        # classic token，勾 repo + workflow
node scripts/deploy-github.mjs --dry-run
node scripts/deploy-github.mjs --repo ip-auto
```

它会：建仓库 → 推代码 → 开 Actions 写权限 → 开 Pages（Source = GitHub Actions）→ 写变量 `NODES_URL` → 触发第一轮并等到跑完 → 打印 `https://<用户名>.github.io/ip-auto/nodes.txt`。

> 已有同名仓库时复用并推送到默认分支，不新建。
> 仓库里已有更新时用 `git fetch` + `merge -X ours` 再推，避免 `stale info` 拒绝。

`cron: '17 3 * * *'`（UTC）= 北京时间每天 11:17。改频率就改 `.github/workflows/vpngate.yml`，例如 `0 */12 * * *`。

### 不想手建 PAT？用 Device Flow

```bash
# 1. 取验证码
curl -x http://127.0.0.1:7897 -X POST https://github.com/login/device/code \
  -H 'accept: application/json' \
  -d 'client_id=178c6fc778ccc68e1d6a&scope=repo%20workflow%20read:user'
# 2. 浏览器打开 https://github.com/login/device?skip_account_picker=true 输入 user_code 授权
# 3. 换 token
curl -x http://127.0.0.1:7897 -X POST https://github.com/login/oauth/access_token \
  -d 'client_id=178c6fc778ccc68e1d6a&device_code=<CODE>&grant_type=urn:ietf:params:oauth:grant-type:device_code'
```

`client_id=178c6fc778ccc68e1d6a` 是 GitHub CLI 的公开 client id。首次授权会触发 sudo 二次验证（邮件码）。

---

## 六、最后一步：把节点喂给 edgetunnel

后台「自定义优选IP / ADD.txt」填：

```
https://jhz1053962051-sketch.github.io/ip-auto/nodes.txt
```

一条命令版：

```bash
# 密码不写进命令行走 shell 历史，从部署记录读
export IP_AUTO_ADMIN="$(node -e "console.log(require('./logs/pages-edge.json').admin)")"
node scripts/edgetunnel-setup.mjs \
  --base https://ipauto-edge.pages.dev \
  --password "$IP_AUTO_ADMIN" \
  --nodes https://jhz1053962051-sketch.github.io/ip-auto/nodes.txt
```

它会登录 → 关掉「随机IP」→ 打开「本地订阅生成」→ 写入 ADD.txt → 回读确认 → 打印订阅地址（含正确 token）。

> **KV 最终一致性约 20 秒**：刚保存后立刻回读还是旧值，等 20 秒再读才对。

---

## 七、验证与排错

```bash
# 订阅能不能直接取到（不需要代理）
curl -sS -H 'user-agent: v2rayN/6.31' \
 "https://ipauto-edge.pages.dev/sub?token=2ce8fa81f3da82450905b322ab649142" | base64 -d | wc -l

# 真实出网 + 归属核查（起 N 个 socks 端口，逐个探 ip-api）
node test/sub-e2e.mjs --count 8

# 入口域名能不能承载我们的 SNI
node test/edge-entry-check.mjs

# 固定 CF IP 能不能承载我们的 SNI
node test/edge-ip-probe.mjs

# 本地检测服务
curl "http://127.0.0.1:8787/check?sstp=vpn:vpn@vpn492686662.opengw.net:1591"

# 云端检测 Worker
curl "https://ipauto-check-sstp.jhz1053962051.workers.dev/check?sstp=vpn:vpn@public-vpn-129.opengw.net:443"

# Worker 代码本地跑（不用等部署）
node test/run-worker.mjs vpn492686662.opengw.net 1591
```

失败模式对照（都已在探测逻辑里被正确归类为「不可用」，不会污染订阅）：

| 报错 | 含义 |
|---|---|
| `Client network socket disconnected before secure TLS connection was established` | 节点已下线 / 端口变了，下一轮自动换 |
| `隧道内 TCP 握手超时` | 隧道通了但内部不通，该节点正在被墙 |
| `探针返回非 JSON（疑似劫持页）` | 出口被运营商劫持到登录页，已剔除 |
| `探针拿到内网/保留地址` | 隧道没通到公网 |
| `schannel: server closed abruptly` | 本机到 CF 边缘的抖动，重试即可 |
| 订阅 401 | token 算错，用 `MD5MD5(host+uuid)` 重算 |

---

## 八、不破坏现有环境的保证

- 所有代码、产物、日志都在 `C:\Users\J1053\Documents\ip-auto` 内，不改 `~/.ssh`、`~/.gitconfig`、系统代理、DNS。
- git 推送用 `-c http.https://github.com/.extraheader=...` **只对那一条命令注入凭据**，不写全局配置、不落 `~/.git-credentials`。
- 计划任务名固定 `ip-auto-daily`，`node scripts/task.mjs remove` 一条命令删干净。
- Cloudflare 侧只创建 `ipauto-*` 前缀的 Worker / Pages / KV（账号里原有的 `noisy-credit-3ce5` 未触碰）；GitHub 侧只操作 `--repo` 指定的那一个仓库。
- 上游参考源码放 `_src/`，已 `.gitignore`；`tools/`（xray.exe 等二进制）同样不入库。
- 探测只读 VPN Gate 公开接口，不做任何写操作。

---

## 九、参考与许可

| 项目 | 用途 | 许可 |
|---|---|---|
| [lsh8848/cm-Workers-CheckSocks5](https://github.com/lsh8848/cm-Workers-CheckSocks5) | SSTP 检测协议参考（Node 版与 Worker 版均按其握手顺序重写，未复制代码） | GPL-3.0 |
| [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) | 订阅生成器，原样使用 | GPL-2.0 |
| [hezhanleiok/gate](https://github.com/hezhanleiok/gate) | 教程对应项目；**只借鉴流程，未引入代码**（无 LICENSE），并修正了其 SSTP 端口写死 443 的缺陷 | 无 LICENSE |
| [XTLS/Xray-core](https://github.com/XTLS/Xray-core) | 端到端验证用的客户端（仅本地测试，不入库） | MPL-2.0 |
| [hoochanlon/fq-book](https://github.com/hoochanlon/fq-book) | 只读参考：`docs/abc/pure.md` 的「纯净度」概念与分档口径，`gfw.md` / `meek.md` / `4dns.md` 印证了已有的 DoH 与「借用大厂域名当门面」两条设计。**无 LICENSE，未引入任何代码** | 无 LICENSE |
| [Scamalytics](https://scamalytics.com/) | 欺诈分数据源（抓网页，免 key） | 商业服务，仅读公开页面 |

节点来源为 [VPN Gate](https://www.vpngate.net/)（学术实验项目，仅限学术用途）。
