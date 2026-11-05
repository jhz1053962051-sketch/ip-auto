# ip-auto · 住宅 IP 节点 24 小时全自动订阅

参照视频/教程（[blog.imxiaohe.com/2026/10/ipcloudflare.html](https://blog.imxiaohe.com/2026/10/ipcloudflare.html)）复刻的完整实现：
从 VPN Gate 抓节点 → SSTP 真实握手探测 → 判定住宅/机房 → 生成订阅 → Cloudflare edgetunnel 套链式代理 → GitHub Actions 每 24 小时自动重跑。

**和教程的差异（重要）**：教程里的 `gate` 项目把 SSTP 端口写死成 443，而 VPN Gate 的**真实家宽节点几乎全部使用随机端口**（1223 / 995 / 1352 / 1591 …）。按教程的做法只能拿到 `public-vpn-NNN` 这类机房节点，住宅节点会被 100% 误判为不可用。本项目从 OpenVPN 配置里读 `remote <ip> <port>` 的真实端口，所以能拿到真家宽出口（实测 JP/KR 各 10 个，全部 `hosting:false`）。

---

## 一、已验证的事实（本机实跑）

```
原始 97 条 → SSTP 63 条 → 检测 24 条
成功 20（住宅 20 / 机房 0），失败 4，耗时 13.8s
国家分布：日本 10 个（住宅 10） / 韩国 10 个（住宅 10）
```

`public/nodes.txt` 实际内容（节选）：

```
saas.sin.fan:443#日本-住宅-01$sstp://vpn:vpn@vpn492686662.opengw.net:1591
www.leics.police.uk:443#韩国-住宅-01$sstp://vpn:vpn@vpn546914302.opengw.net:1338
```

Cloudflare Worker 版也已在 Node 里用 `cloudflare:sockets` 替身真跑通过：

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
│  ├─ sstp.mjs       SSTP / PPP / IPCP / PPP 上的 TCP —— 全手写
│  ├─ probe.mjs      单节点探测（DoH 解析 → SSTP 隧道 → 取出口 IP）
│  ├─ vpngate.mjs    VPN Gate 抓取与解析（含真实 SSTP 端口修复）
│  ├─ geo.mjs        出口 IP 归属判定（ip-api 批量 + 关键词兜底）
│  ├─ edges.mjs      优选入口池 + nodes.txt 生成
│  ├─ render.mjs     概览页 HTML
│  └─ run.mjs        主流水线
├─ cloudflare/
│  └─ check-worker.js  可直接粘贴到 CF 后台的单文件检测 Worker
├─ scripts/
│  ├─ local-worker.mjs 本地检测服务（/check?sstp=...）
│  ├─ serve.mjs        本地静态站点（预览 public/）
│  ├─ schedule.mjs     常驻守护进程（每 N 小时跑一轮）
│  ├─ task.mjs         Windows 计划任务安装/删除/查看
│  ├─ deploy-cloudflare.mjs  CF 一键部署（纯 API）
│  ├─ deploy-github.mjs      GitHub 一键部署（纯 API）
│  └─ summary.mjs      结果摘要
├─ test/
│  ├─ mock-sockets.mjs cloudflare:sockets 的 Node 替身
│  └─ run-worker.mjs   在 Node 里直接跑 Worker 代码
├─ public/           产物（data.json / nodes.txt / index.html / subscription.txt）
└─ .github/workflows/vpngate.yml
```

---

## 三、本地跑（不依赖任何云账号）

```bash
cd C:/Users/J1053/Documents/ip-auto

node src/run.mjs                       # 全量：抓 → 探测 → 生成
node src/run.mjs --countries JP,KR --max 80 --concurrency 8

node scripts/serve.mjs                 # http://127.0.0.1:8080 预览
node scripts/local-worker.mjs          # http://127.0.0.1:8787 检测服务
```

### 24 小时自动更新，二选一

**A. Windows 计划任务（推荐，已装好）**

```bash
node scripts/task.mjs status           # 看下次运行时间
node scripts/task.mjs install --time 09:30
node scripts/task.mjs remove           # 随时删干净，不留痕
```

**B. 常驻守护进程（想在终端里看着它跑）**

```bash
node scripts/schedule.mjs              # 立即跑一轮，之后每 24h（带 ±20min 抖动）
node scripts/schedule.mjs --every 6 --no-initial
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `IP_AUTO_PROXY` | `http://127.0.0.1:7897` | 本机代理；CI 里置空走直连 |
| `IP_AUTO_COUNTRIES` | `JP,KR` | 国家白名单，`all` 不限 |
| `IP_AUTO_MAX_NODES` | `80` | 最多检测多少条 |
| `IP_AUTO_CONCURRENCY` | `6` | 并发探测数 |
| `IP_AUTO_TIMEOUT_MS` | `22000` | 单节点超时 |
| `IP_AUTO_DOH` | `https://dns.google/resolve` | DoH 端点（本机 DNS 对 opengw.net 有污染） |

---

## 四、部署到 Cloudflare

教程是在网页上手工粘贴代码。这里给一条命令的版本，**只创建自己的资源，不改动任何已有 Worker**。

### 1. 拿 API Token

打开 <https://dash.cloudflare.com/profile/api-tokens> → Create Token → Custom token，权限给：

- Account → **Workers Scripts** → Edit
- Account → **Workers KV Storage** → Edit
- Account → **Account Settings** → Read

```bash
export CF_API_TOKEN=你的token
node scripts/deploy-cloudflare.mjs --dry-run    # 先看它要做什么
node scripts/deploy-cloudflare.mjs
```

它会做完：校验 token → 选账号 → 确认 workers.dev 子域 → 建 KV `ipauto-edgetunnel-KV` → 上传 `ipauto-edgetunnel`（绑 KV + 随机 ADMIN 密码）→ 上传 `ipauto-check-sstp` → 自检 → 把地址和密码写进 `logs/cloudflare-deploy.json`。

想改名字：`--prefix myname`；想指定密码：`--admin 你的密码`。

### 2. 手动版（不想给 Token）

照教程走即可，材料都在仓库里：

| 步骤 | 用什么 |
|---|---|
| 检测 Worker | `cloudflare/check-worker.js`（整文件粘贴，单文件零依赖） |
| edgetunnel | `_src/cmliu_edgetunnel/_worker.js`（上游原版，5 MB） |
| edgetunnel 环境变量 | `ADMIN` = 你的后台密码 |
| edgetunnel KV 绑定 | 变量名必须是 `KV` |

部署完访问 `https://<你的edgetunnel>.workers.dev/admin` 登录，记下 UUID 和节点域名。

---

## 五、部署到 GitHub（24 小时自动跑）

### 1. 拿 Token

<https://github.com/settings/tokens> → Generate new token (classic) → 勾 **repo** + **workflow**。

```bash
export GH_TOKEN=ghp_xxxx
node scripts/deploy-github.mjs --dry-run
node scripts/deploy-github.mjs --repo ip-auto
```

它会：建仓库 → 推代码 → 开 Actions 写权限 → 开 Pages（Source = GitHub Actions）→ 写变量 `NODES_URL` → 触发第一轮并等到跑完 → 打印 `https://<用户名>.github.io/ip-auto/nodes.txt`。

> 已有同名仓库时会复用并推送到它的默认分支，不会建新的。

### 2. 全自动节奏

`.github/workflows/vpngate.yml` 里 `cron: '17 3 * * *'`（UTC）= 北京时间每天 11:17。可以改成教程推荐的其它频率，比如 `0 */12 * * *`（每 12 小时）。

---

## 六、最后一步：把节点喂给 edgetunnel

打开 `https://<你的edgetunnel>.workers.dev/admin` → 登录 → 「自定义优选IP / ADD.txt」→ 填订阅地址：

```
https://<用户名>.github.io/ip-auto/nodes.txt
```

edgetunnel 每次生成订阅时会拉这个地址，把每行解析成「优选入口 + `$sstp://` 链式代理」。之后客户端订阅 edgetunnel 的订阅链接即可，节点会随 GitHub Actions 每天自动更新。

---

## 七、验证与排错

```bash
# 本地检测服务自检（看隧道是否真能出去）
curl "http://127.0.0.1:8787/check?sstp=vpn:vpn@vpn492686662.opengw.net:1591"

# 云端检测 Worker 自检
curl "https://ipauto-check-sstp.<子域>.workers.dev/check?sstp=vpn:vpn@public-vpn-129.opengw.net:443"

# Worker 代码在本地跑（不用等部署）
node test/run-worker.mjs vpn492686662.opengw.net 1591

# 看历史运行
node scripts/task.mjs status && tail -20 logs/task.log
```

常见失败模式（都已在探测逻辑里被正确归类为「不可用」，不会污染订阅）：

| 报错 | 含义 |
|---|---|
| `Client network socket disconnected before secure TLS connection was established` | 节点已下线 / 端口变了，下一轮会自动换 |
| `隧道内 TCP 握手超时` | 隧道通了但内部不通，通常是该节点正在被墙 |
| `探针返回非 JSON（疑似劫持页）` | 出口被运营商劫持到登录页，不是干净节点，已剔除 |
| `探针拿到内网/保留地址` | 隧道没通到公网 |

---

## 八、不破坏现有环境的保证

- 所有代码、产物、日志都在 `C:\Users\J1053\Documents\ip-auto` 内，不改 `~/.ssh`、`~/.gitconfig`、系统代理、DNS。
- 计划任务名固定为 `ip-auto-daily`，`node scripts/task.mjs remove` 一条命令删干净。
- Cloudflare 侧只创建 `ipauto-*` 前缀的 Worker 和 KV；GitHub 侧只操作 `--repo` 指定的那一个仓库。
- 上游参考源码放在 `_src/`，已 `.gitignore`，不会被推上去。
- 检测逻辑只读 VPN Gate 公开接口，不做任何写操作。

---

## 九、参考与许可

| 项目 | 用途 | 许可 |
|---|---|---|
| [lsh8848/cm-Workers-CheckSocks5](https://github.com/lsh8848/cm-Workers-CheckSocks5) | SSTP 检测协议实现的参考（本项目的 Node 版与 Worker 版均按其握手顺序重写，未复制代码） | GPL-3.0 |
| [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) | 订阅生成器，原样使用 | GPL-2.0 |
| [hezhanleiok/gate](https://github.com/hezhanleiok/gate) | 教程对应项目；**只借鉴流程，未引入代码**（无 LICENSE 文件）；并修正了其 SSTP 端口写死 443 的缺陷 | 无 LICENSE |

节点来源为 [VPN Gate](https://www.vpngate.net/)（学术实验项目，仅限学术用途）。
