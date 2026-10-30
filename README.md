# vps-probe

轻量 VPS 监控：一个 hub 管一队节点，附带管理后台与公开状态页。Rust + SQLite，二进制静态链接，无运行时依赖。

## 组成

| 目录 | 说明 |
|---|---|
| `monitor/` | hub：后台、API、公开页宿主（Rust + axum + SQLite） |
| `agent/` | Linux 采集端（musl 静态二进制，WebSocket + JSON-RPC 2.0 上报） |
| `monitor/web-admin/` | 管理后台前端（Vite + React），构建期嵌入 hub |
| `monitor/web-site/` | 公开状态页（Vite + React），构建期嵌入 hub |

```
probe-agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  probe-hub (axum + SQLite)  ──▶  后台 + 状态页
```

## 安装 hub

```sh
curl -fsSL https://github.com/imlilian/vps-probe/releases/latest/download/install-hub.sh -o install-hub.sh
sudo sh install-hub.sh
```

有终端时给菜单，`curl | sh` 按默认安装。hub 只监听 `127.0.0.1:28080`，公网访问要自己配
nginx / caddy / CF 隧道。hub 默认不知道自己的对外地址——用域名打开面板后，到「设置」里填
站点 URL 就行（必须 https，面板会自动填入你正在用的地址）；想把它钉死在命令行、不让面板
改，就用 `--site https://你的域名` 安装，面板里那一项随之锁定。

OIDC 登录必须有这个地址：授权请求和换 token 都要原样带上回调地址，hub 不会从请求里猜。

升级与卸载（重跑即升级，端口和 `--site` 沿用上次的，起不来自动回滚）：

```sh
sudo sh install-hub.sh --upgrade
sudo sh install-hub.sh --uninstall     # 保留数据
sudo sh install-hub.sh --purge         # 连数据库一起删
```

## 安装 agent

在面板添加节点，复制生成的命令到目标机器执行：

```sh
curl -fsSL https://your-hub/install.sh | sh -s -- --server https://your-hub --token <token>
```

节点只需要能访问 hub，**不需要访问 GitHub**：hub 代为下载并验签后转发。二进制装到
`/opt/probe/probe-agent`，token 在 `/opt/probe/agent.env`（0600）。

```sh
# 升级：从 hub 拉最新版，复用本机 token，不重新注册、不消耗注册密钥
curl -fsSL https://your-hub/install.sh | sh -s -- --upgrade

# 卸载：删除 unit、二进制、env、日志与系统用户
curl -fsSL https://your-hub/install.sh | sh -s -- --uninstall
```

## 健康检查（接外部 uptime）

hub 监测所有节点，唯独监测不到自己：在 hub 那台机器上装 agent，它的上报也要经过 hub 本身。
所以留了一个朝外看的接口，给它之外的 uptime 服务定时查询：

```sh
curl -s https://your-hub/api/health
# {"db":"ok","status":"ok","uptime_seconds":3600}
```

| 情况 | 答复 |
|---|---|
| 正常 | `200`，`"status":"ok"` |
| 数据库读不出来 | `503`，`"status":"degraded"`、`"db":"error"` |
| 备份 / vacuum / 图表扫描正占着连接 | `200`，`"db":"busy"`——忙不是故障 |
| hub 进程没了、端口不通、代理挂了 | 连不上或超时，由 uptime 判掉线 |

- **不需要登录**：uptime 服务不持有会话，也不会被给一个。
- **不会被缓存**：响应带 `Cache-Control: no-store`，Cloudflare 和反向代理不会把一次 200
  缓存成永久绿——那正是这个接口要抓的故障。
- **只说活着**：不带版本号（哪个 release 的漏洞不该让随便谁查到），不带节点数（那是一门
  炮的规模），面板里登录后都能看到。

面板左侧的**「心跳」**页把这条地址、响应约定和接法都列了出来，带复制按钮，不必翻文档。

在 Uptime Kuma 里加一个 **HTTP(s)** 监视器：URL 填 `https://your-hub/api/health`，
期望状态码 `200`，其余默认。Kuma 与 hub 同机时直接查 `http://127.0.0.1:28080/api/health`，
不必绕 TLS 代理。想把「数据库还能读」一起盯上，就用 **HTTP(s) - Keyword** 类型，关键词填
`"db":"ok"`（或 **JSON Query** 查 `$.status` 等于 `ok`）：503 时关键词不出现，监视器照样红。
UptimeRobot、Better Stack、Grafana 合成监控这些换汤不换药：别只把检查器放在 hub 同一台机器上，
机器死了两边一起沉默，也就没了引入外部 uptime 的意义。

## 构建

需要 Rust stable 与 node。

```sh
make theme    # 公开页：装依赖 + 构建（全新 clone 先跑这一次）
make hub      # 后台前端 + hub 二进制（公开页随后由 build.rs 按源码指纹同步）
make agent    # 采集端
make check    # 两个前端的 lint + cargo check
make test     # 前端测试 + cargo test
```

两个前端都是构建期输入：`cargo build` 只保证 `web-site/` 的 `dist/` 跟得上源码（`build.rs` 调
`scripts/theme.sh`，按源码指纹判断要不要重建），`web-admin/` 的 `dist/` 得由 `make admin` 先建好
——`make hub` 已经包含这一步。随后 rust-embed 把两份 `dist/` 嵌进二进制。改完 `web-site/` 或
`web-admin/` 后重新 `make hub` 即生效，不需要发版、不需要改 pin、也不需要联网。

## 发布

推送 `v*` tag，`.github/workflows/release.yml` 出双架构（x86_64 / aarch64 musl）二进制并
用 ed25519 签名。**tag 是纯发行序号**（单调递增、永不复用），不等于任何组件的版本号；
`monitor/Cargo.toml` 与 `agent/Cargo.toml` 各自只随自己的代码改动 bump。每个 release 都
同时含两个组件的全部资产：本次没改的组件**原样继承**上一版的二进制 + 签名（不重编译、
不重签），CI 从两个 Cargo.toml 生成 `versions.json` 随 release 发布，面板读它区分
「hub/agent 是否需要更新」，读不到则回退 tag（旧 hub 的行为不变）。

版本号别手改，交给脚本，bump 谁由参数决定：

```sh
make release VERSION=0.2.2              # 两个组件都 bump 到 0.2.2
make release HUB=0.2.2                  # 只 bump hub
make release AGENT=0.3.0                # 只 bump agent
make release HUB=0.2.2 AGENT=0.3.0      # 各 bump 各的号
```

它把选中组件的 `Cargo.toml` 和 `Cargo.lock` 一起改好（`release.yml` 用 `--locked` 构建，
锁文件落后于清单会直接失败）、提交，然后停下——**不推送、不打 tag**，末尾会打印算好的
下一个 tag 号（当前最大 tag 的 patch +1，与组件版本无关）。按提示顺序执行：`git push`
→ 等分支 CI 绿 → `git tag vX && git push origin vX`。加 `--dry-run` 只看会改哪几行。

继承的判定依据是 Cargo.toml 版本号与上一版 release 的 versions.json 是否相同：版本没动
就继承旧二进制。忘了 bump 的最坏后果是那一版沿用旧二进制（签名有效、节点无损），下一版
可修正——所以 CI 不做强校验，只由脚本在本地提醒：改了某组件却没带对应参数时打警告，
`--force` 跳过。

签名私钥只存在于仓库的 Actions secret `AGENT_SIGNING_KEY`，任何机器上都没有。公钥有两份副本：
`monitor/src/main.rs` 的 `AGENT_SIGNING_KEY`（hub 转发 agent 时验签）与 `monitor/install-hub.sh`
的 `PUBKEY`（安装 hub 时验签）。**轮换密钥要同时改这两处并发版。**

## 安全取舍

- 主题市场整体移除：主题是任意 HTML/JS 包，装进公开页后对匿名访客执行且无签名校验，是供应链
  投毒面。公开页固定使用本仓库内嵌的那一份。
- 公开页默认关闭：新装的 hub 不对外发布节点位置、流量与延迟，需要在面板里显式打开。关闭时
  访问者看到的是「状态页已关闭」，而不是空白或报错。
- `/api/health` 匿名开放，但只答「活着没有」与「这个进程跑了多久」：版本号、节点数、地址都不
  在里面。它要答的东西必须比它泄露的东西更值钱，否则就是一个免费的信息源。
- 面板与公开页都带 CSP、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`：脚本只允许
  同源加载，页面不能被 iframe 嵌入。
- 两个二进制都签名，hub 只在验签通过后转发 agent；hub 安装器同样验签后才落盘，不再依赖与二进制
  同源的 sha256。
- 安装器不会自我替换：旧版本脚本留在机器上也只是装出同样经过验签的二进制。
- 两个服务都以 `systemd-analyze security` 的 1.8（OK）运行：清空能力集、运行期不建命名空间、
  只放行 `@system-service` 那组系统调用。万一某次改动用到组外的调用，journal 里会写
  `status=31/SYS`，用 `systemctl edit` 补一组即可，不必重装。

## 许可

MIT
