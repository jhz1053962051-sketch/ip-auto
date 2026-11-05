# ip-auto · 住宅 IP 节点 24 小时全自动订阅

参照视频/教程（[blog.imxiaohe.com/2026/10/ipcloudflare.html](https://blog.imxiaohe.com/2026/10/ipcloudflare.html)）复刻并跑通的完整实现：
从 VPN Gate 抓节点 → SSTP 真实握手探测 → 判定住宅/机房 → 生成订阅 → Cloudflare edgetunnel/Pages 套链式代理 → GitHub Actions 每 24 小时自动重跑。

## 已经在线跑着的东西

| 用途 | 地址 | 备注 |
|---|---|---|
| **节点总览（浏览器看这个）** | `https://jhz1053962051-sketch.github.io/ip-auto/` | 每条节点都带「复制 vless」，点一下就能导入；纯静态 0.6s 打开 |
| **订阅链接（喂客户端）** | `https://ipauto-edge.pages.dev/sub?token=2ce8fa81f3da82450905b322ab649142` | 直连可用，不需要任何代理；日本 / 韩国 / 新加坡 三国节点 |
| 订阅（Clash 版） | 同上加 `&clash` | 输出 Clash YAML |
| 后台管理 | `https://ipauto-edge.pages.dev/admin` | 密码 `CNarKCJvMAYk` |
| 检测 Worker（Cloudflare） | `https://ipauto-check-sstp.jhz1053962051.workers.dev` | `/check?sstp=vpn:vpn@HOST:PORT` |
| 节点池（GitHub Pages） | `https://jhz1053962051-sketch.github.io/ip-auto/nodes.txt` | edgetunnel 每天从这里取 |
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

---

## 二、目录结构

```
ip-auto/
├─ src/
│  ├─ http.mjs       无依赖 HTTP 客户端（手写 CONNECT 代理、TLS、响应解析）
│  ├─ sstp.mjs       SSTP / PPP / LCP / PAP / IPCP / PPP 上的 TCP —— 全手写
│  ├─ probe.mjs      单节点探测（DoH 解析 → SSTP 隧道 → 取出口 IP → 严格校验）
│  ├─ vpngate.mjs    VPN Gate 抓取与解析（含真实 SSTP 端口修复 + 截断重试）
│  ├─ proxysrc.mjs   公共代理池数据源（proxyscrape / geonode），给新加坡这类 VPN Gate 没有的国家用
│  ├─ proxycheck.mjs socks5 / http 代理探针（路径与线上 Worker 的 /admin/check 完全一致）
│  ├─ proxynodes.mjs 代理候选 → 探测 → 出口国家校验 → 节点（协议无关）
│  ├─ geo.mjs        出口 IP 归属判定（ip-api 批量 + 关键词兜底）
│  ├─ edges.mjs      实测可用的入口池（8 个固定 CF IP + 14 个域名）+ nodes.txt 生成
│  ├─ sub.mjs        订阅 token（MD5MD5）/ vless 链接生成，算法与 Worker 逐字节一致
│  ├─ render.mjs     概览页 HTML（顶部订阅面板 + 每条节点的复制按钮）
│  └─ run.mjs        主流水线
├─ cloudflare/
│  └─ check-worker.js  可直接粘贴到 CF 后台的单文件检测 Worker（真 SSTP 握手）
├─ scripts/
│  ├─ local-worker.mjs    本地检测服务（/check?sstp=...）
│  ├─ serve.mjs           本地静态站点（预览 public/）
│  ├─ schedule.mjs        常驻守护进程（每 N 小时跑一轮）
│  ├─ run-task.cmd        计划任务实际执行的包装脚本
│  ├─ task.mjs            Windows 计划任务安装/删除/查看
│  ├─ deploy-cloudflare.mjs  CF 一键部署（纯 API，Worker 版）
│  ├─ deploy-pages-edge.mjs  CF Pages 一键部署（wrangler 上传，直连版）
│  ├─ deploy-github.mjs      GitHub 一键部署（纯 API）
│  ├─ edgetunnel-setup.mjs   登录后台、改成读自己的 nodes.txt、打印订阅地址
│  ├─ show-sub.mjs           只算并打印订阅地址（改域名/UUID 后重算 token）
│  ├─ render-only.mjs        只重渲染 index.html，不重新探测（改样式时秒看效果）
│  ├─ make-xray-node.mjs     从订阅生成 Xray 配置（单节点 / 指定国家 / 指定入口）
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
└─ .github/workflows/vpngate.yml
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

**A. Windows 计划任务（已装好，推荐）**

```bash
node scripts/task.mjs status           # 看下次运行时间 / 上次结果
node scripts/task.mjs install --time 09:30
node scripts/task.mjs remove           # 随时删干净，不留痕
```

> 计划任务实际跑的是 `scripts/run-task.cmd`（不是直接把引号和重定向塞进 `schtasks /TR`，那样重定向会失效且 `Last Result` 变 1）。

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
| `IP_AUTO_PROXY_MAX` | `260` | 每个代理池国家最多取多少候选 |
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
node scripts/edgetunnel-setup.mjs \
  --base https://ipauto-edge.pages.dev \
  --password CNarKCJvMAYk \
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

节点来源为 [VPN Gate](https://www.vpngate.net/)（学术实验项目，仅限学术用途）。
