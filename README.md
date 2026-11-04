# vps-probe

轻量 VPS 监控：一个 hub 管一队节点，附带管理后台与公开状态页。Rust + SQLite，
单个静态链接二进制，无运行时依赖，常驻内存数 MB。

- 秒级采集与实时看板；延迟 / 重传 / 丢包分开记，不混成一个数
- 公开状态页可选；掉线、流量、到期、登录可推送到 Telegram / Webhook / 邮件
- 自托管，数据在自己手里；节点只需要能访问 hub

```
probe-agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  probe-hub (axum + SQLite)  ──▶  后台 + 状态页
```

具体口径与设计取舍（延迟三口径、登录方式、通知、健康检查、发布源与安全）见
[`docs/功能与实现细节.md`](docs/功能与实现细节.md)——这份 README 只管装、编、注意什么。

## 目录结构

| 目录 | 说明 |
|---|---|
| `hub/` | hub：后台、API、公开页宿主（Rust + axum + SQLite） |
| `hub/install-hub.sh` | hub 安装器（随 release 发布，本地这份用于开发时试跑） |
| `hub/install-agent.sh` | agent 安装器，由 hub 对外分发 |
| `agent/` | Linux 采集端（musl 静态二进制，WebSocket + JSON-RPC 2.0 上报） |
| `hub/web-admin/` | 管理后台前端（Vite + React），构建期嵌入 hub |
| `hub/web-site/` | 公开状态页（Vite + React），构建期嵌入 hub |
| `scripts/` | `release.sh` 版本号 bump、`mirror.sh` 自建发布源镜像 |
| `docs/` | 常驻文档，随代码入库（如 `功能与实现细节.md`） |
| `docs/dev/` | 开发过程记录与中间产物，不入库 |

## 安装 hub

```sh
curl -fsSL https://github.com/imlilian/vps-probe/releases/latest/download/install-hub.sh -o install-hub.sh
sudo sh install-hub.sh
```

有终端时给菜单，`curl | sh` 按默认安装。装完的布局：

| 项 | 位置 |
|---|---|
| 二进制 | `/opt/probe/probe-hub` |
| 数据库 | `/opt/probe/data/probe.db`（0700，属主 `probe-hub`） |
| 服务账号 | `probe-hub`（系统账号，无 home、nologin） |
| 监听 | `127.0.0.1:28080` |

hub 只监听本机，公网访问要自己配 nginx / caddy / CF 隧道。用域名打开面板后到
「设置」里填站点 URL（面板会自动填入你正在用的地址）；想钉死在命令行、不让面板改，
就用 `--site https://你的域名` 安装。**OIDC 登录必须有站点 URL**：回调地址要原样发给
身份系统，hub 不会从请求里猜。

```sh
sudo sh install-hub.sh --port 8443          # 换监听端口
sudo sh install-hub.sh --reset-password     # 重置面板密码，登出所有会话
sudo sh install-hub.sh --uninstall          # 卸载，保留数据与账号
sudo sh install-hub.sh --purge              # 数据与账号一起删
sudo sh install-hub.sh --help               # 全部参数
```

升级 = 重跑安装器，没写的参数沿用上次（端口、`--site`、发布源），起不来自动回滚。
但安装器不自我替换，**升级前先重新取一份**，否则 `--upgrade` 会拒绝执行：

```sh
curl -fsSL https://github.com/imlilian/vps-probe/releases/latest/download/install-hub.sh -o install-hub.sh
sudo sh install-hub.sh --upgrade
```

二进制按 ed25519 签名校验，公钥编在安装器里，所以**换发布源不影响可信度**。GitHub
不可达或要自建镜像时：

```sh
sudo sh install-hub.sh --release-base https://dl.example.com/vps-probe  # 换源
sudo sh install-hub.sh --release-base official                          # 改回官方
scripts/mirror.sh --dest /srv/dl/vps-probe --public-base https://dl.example.com/vps-probe
```

镜像地址会写进 systemd 单元并被面板继承（面板「更新」页照它取版本、给节点转发 agent
二进制），面板里改不了——换源就重跑安装器。镜像目录下要有
`probe-hub-<arch>-unknown-linux-musl`、同名 `.sig` 和 `versions.json`。

## 安装 agent

在面板添加节点，复制生成的命令到目标机器执行：

```sh
curl -fsSL https://your-hub/install-agent.sh | sh -s -- --server https://your-hub --token <token>
```

节点只需能访问 hub，**不需要访问 GitHub**（hub 代为下载并验签后转发）。二进制在
`/opt/probe/probe-agent`，token 在 `/opt/probe/agent.env`（0600），服务账号 `probe-agent`。
支持 systemd 与 OpenRC。

```sh
curl -fsSL https://your-hub/install-agent.sh | sh -s -- --upgrade     # 复用本机 token，不重新注册
curl -fsSL https://your-hub/install-agent.sh | sh -s -- --uninstall
```

`install-agent.sh --help` 列全部参数（`--register` 用注册密钥换 token、`--iface` 选网卡、
`--interval` 调上报间隔、`--insecure` 允许明文 `http://`）。

## 构建

需要 Rust stable 与 node。全新 clone 先跑一次 `make theme`（公开页要备好依赖和 dist），
之后：

```sh
make hub      # 后台前端 + hub 二进制（含公开页按源码指纹同步）
make agent    # 采集端
make check    # 与 CI 逐字一致的守卫 + 两个前端 lint + fmt + clippy
make test     # 前端测试 + cargo test
make clean    # 清掉 dist 与 target
```

两个前端都是**构建期输入**：`rust-embed` 把两份 `dist/` 嵌进二进制。`cargo build` 只保证
`web-site/` 跟得上源码（`build.rs` 调 `scripts/theme.sh`，按指纹判断），`web-admin/` 的
`dist/` 得先由 `make admin` 建好——`make hub` 已包含。改完前端重新 `make hub` 即生效，
不需要发版、不需要改 pin、也不需要联网。

## 发布

推 `v*` tag 触发 `.github/workflows/release.yml`，出 x86_64 / aarch64 musl 二进制并用
ed25519 签名。tag 是**纯发行序号**（单调递增、永不复用），不等于任何组件版本；两个组件的
`Cargo.toml` 各管各的号，本次没改的组件原样继承上一版二进制与签名。

```sh
make release VERSION=0.2.2            # 两个组件同号
make release HUB=0.2.2                # 只 bump hub
make release AGENT=0.3.0              # 只 bump agent
```

脚本改好 `Cargo.toml` + `Cargo.lock` 并提交，然后就停——**不推送、不打 tag**，末尾打印
下一个 tag 号。按提示：`git push` → CI 绿 → `git tag vX && git push origin vX`。

## 注意点

- **别手改版本号**。用 `make release ...`，`release.yml` 以 `--locked` 构建，锁文件落后
  于清单会直接失败。
- **签名私钥只在 Actions secret `AGENT_SIGNING_KEY` 里**，任何机器上都没有。公钥有两份
  副本：`hub/src/main.rs` 的 `AGENT_SIGNING_KEY`（hub 转发 agent 时验签）与
  `hub/install-hub.sh` 的 `PUBKEY`。**轮换密钥要同时改这两处并发版。**
- **hub 与 agent 即使同机也跑在两个账号下**（`probe-hub` / `probe-agent`）。agent 读不到
  数据库目录（0700，属主 `probe-hub`），一个节点侧的问题才变不成整支舰队的 token 泄漏。
- **安装器不自我替换是有意的**：从网络取脚本以 root 执行等于执行任意代码，被签名的是
  二进制。所以"重跑手上那份"不等于升级。
- **公开页默认关闭**，要在面板里显式打开；关闭时访客看到「状态页已关闭」，不是空白或报错。
- 面板与公开页都带 CSP / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`；两个服务
  以 `systemd-analyze security` 1.8（OK）运行，若某次改动用到 `@system-service` 组外的系统
  调用，journal 里会写 `status=31/SYS`，用 `systemctl edit` 补一组即可。
- 改代码前先跑 `make check`：它跑的是 CI 那条 clippy（`--all-targets -- -D warnings`），
  `cargo check` 不会发现这些 lint。

## 许可

MIT
