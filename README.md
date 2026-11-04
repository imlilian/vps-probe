# vps-probe

轻量 VPS 监控：一个 hub 管一队节点，附带管理后台与公开状态页。Rust + SQLite，二进制静态链接，无运行时依赖。

## 组成

| 目录 | 说明 |
|---|---|
| `hub/` | hub：后台、API、公开页宿主（Rust + axum + SQLite） |
| `agent/` | Linux 采集端（musl 静态二进制，WebSocket + JSON-RPC 2.0 上报） |
| `hub/web-admin/` | 管理后台前端（Vite + React），构建期嵌入 hub |
| `hub/web-site/` | 公开状态页（Vite + React），构建期嵌入 hub |

```
probe-agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  probe-hub (axum + SQLite)  ──▶  后台 + 状态页
```

## 延迟口径

延迟检测是一条 TCP 握手（`connect`）的往返时间。三个数分开记，不要相加：

| 指标 | 定义 | 以前 |
|---|---|---|
| **延迟** | 首包 RTT，毫秒。首包丢过、被内核重传救回来的样本已扣掉那 1 秒等待 | 这类样本直接记成丢包 |
| **重传** | 需要内核重传才完成的握手 ÷ 样本数 | 拿不到，被丢包吞掉 |
| **丢包** | 3 秒内没有完成的握手 ÷ 样本数 | 期限是 900ms，于是丢一个 SYN 就算丢包 |

**首包丢失率 ≈ 重传率 + 丢包率。** 内核在 SYN 无人应答后 1 秒重传一次：丢掉的通常会被
救回来（记重传，延迟里扣掉那 1 秒），连丢两个才会在 3 秒内无人应答（记丢包）。一条
「偶尔丢包」的线路，读数是 延迟 ~175ms · 重传 4.7% · 丢包 0.3%，而不是一天里每隔
二十分钟亮一次红。

- 一轮探测共享 3 秒预算，不是每个地址 3 秒：多地址目标不会把一轮拖到 9 秒。
- 域名解析失败、端口拒绝、无路由、文件描述符耗尽**不记丢包**，改为这一轮不发样本——
  这些是本机或配置的事，链路一个包都没丢。每类每会话在 `journalctl -u probe-agent` 里
  有一行说明，正常样本不打日志。
- 旧 agent 不报 `retx` 时按重传 0 计；旧 hub 的公开页不画质量条。两种混跑时数字不可比，
  升级 agent 即消除。数据库就地升级（`user_version` 13 → 14，两个带默认值的列），
  不需要重配，历史行的重传按 0 读。

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
sudo sh install-hub.sh --uninstall     # 保留数据与系统用户
sudo sh install-hub.sh --purge         # 数据库和系统用户一起删
```

二进制、数据和服务账号：`/opt/probe/probe-hub`、`/opt/probe/data/probe.db`（0700，属主
`probe-hub`）、账号 `probe-hub`（系统账号，无 home、nologin，跟服务名一致）。数据在，账号
就得在——`--purge` 把两者一起删，`--uninstall` 保留，重装才能接着用同一个库。

二进制按 ed25519 签名校验，`install-hub.sh` 自己带公钥，所以**换发布源不影响可信度**。
要从别处装（自建镜像、公司内网、GitHub 不可达）：

```sh
sudo sh install-hub.sh --release-base https://dl.example.com/vps-probe
```

那个地址下要有同名文件（`probe-hub-<arch>-unknown-linux-musl` 和它的 `.sig`、`versions.json`）。
拿不到 tag 只影响屏幕上那行版本，不影响安装。装完 `probe-hub --version` 可以核对实际版本。

## 安装 agent

在面板添加节点，复制生成的命令到目标机器执行：

```sh
curl -fsSL https://your-hub/install-agent.sh | sh -s -- --server https://your-hub --token <token>
```

节点只需要能访问 hub，**不需要访问 GitHub**：hub 代为下载并验签后转发。二进制装到
`/opt/probe/probe-agent`，token 在 `/opt/probe/agent.env`（0600）。

服务账号是 `probe-hub` 与 `probe-agent`（都是无 home、nologin 的系统账号），名字跟服务名
一致。hub 那台机器上同时装 agent 时是两个账号，不是一个：`/opt/probe/data` 是 0700 属主
`probe-hub`，agent 要读不到数据库才能挡住「一个节点上的问题变成整支舰队的 token 泄漏」。
旧地址 `/install.sh` 仍然可用，以前复制出去的命令不会失效。

```sh
# 升级：从 hub 拉最新版，复用本机 token，不重新注册、不消耗注册密钥
curl -fsSL https://your-hub/install-agent.sh | sh -s -- --upgrade

# 卸载：删除 unit、二进制、env、日志与系统用户
curl -fsSL https://your-hub/install-agent.sh | sh -s -- --uninstall
```

`install-agent.sh --help` 列全部参数；`probe-agent --version` 看装的是哪一版。

## 登录方式

面板的会话可以来自三种凭据，彼此独立——只开一种、或者全开都行：

| 方式 | 在哪配 | 回调地址 |
|---|---|---|
| 密码 | 「安全」页设置 | — |
| GitHub 登录 | 「安全」页填 Client ID / Secret | `{站点URL}/api/auth/github/callback` |
| 通用 OIDC | 「安全」页填 Issuer / Client ID / Secret | `{站点URL}/api/auth/oidc/callback` |

面板「安全」页会按当前站点 URL 把两个回调地址直接写出来，照抄进身份系统即可。Client Secret
只能写、不能读回来，之后只显示「已设置」。

**通用 OIDC** 走标准 discovery：hub 取 `{issuer}/.well-known/openid-configuration`，用其中
的授权、token、userinfo 三个端点；流程是授权码 + PKCE（S256），scope 是 `openid profile`。
所以 Keycloak、Authentik、Authelia、Pocket ID、Azure AD 这类实现了 OIDC 发现的都能直接用，
不需要为某个 provider 写适配。

几个容易踩的地方：

- **Issuer 填 base URL**（例如 `https://id.example.com/realms/monitor`）。填成完整的发现地址
  也行——hub 会把 `/.well-known/openid-configuration` 后缀摘掉，因为从身份系统界面上复制的
  通常就是那一条。
- **必须先有站点 URL**。回调地址要用它拼，而且授权请求和换 token 两次必须逐字相同，hub 不会
  从请求里猜。没填、或不是 https 时，登录按钮不出现，直接访问那个路由也会被拒。
- **允许登录的用户列表是必填的，空着谁也登不进去**。这是故意的：留空等于 provider 上的任何
  账号都能进面板。匹配的是 `preferred_username`，所以 scope 里带了 `profile`。
- GitHub 登录的允许列表同理，匹配的是 GitHub 用户名；scope 只有 `read:user`。

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
make check    # 测试不进包的守卫 + 两个前端的 lint + cargo check
make test     # 前端测试 + cargo test
```

两个前端都是构建期输入：`cargo build` 只保证 `web-site/` 的 `dist/` 跟得上源码（`build.rs` 调
`scripts/theme.sh`，按源码指纹判断要不要重建），`web-admin/` 的 `dist/` 得由 `make admin` 先建好
——`make hub` 已经包含这一步。随后 rust-embed 把两份 `dist/` 嵌进二进制。改完 `web-site/` 或
`web-admin/` 后重新 `make hub` 即生效，不需要发版、不需要改 pin、也不需要联网。

## 发布

推送 `v*` tag，`.github/workflows/release.yml` 出双架构（x86_64 / aarch64 musl）二进制并
用 ed25519 签名。**tag 是纯发行序号**（单调递增、永不复用），不等于任何组件的版本号；
`hub/Cargo.toml` 与 `agent/Cargo.toml` 各自只随自己的代码改动 bump。每个 release 都
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
`hub/src/main.rs` 的 `AGENT_SIGNING_KEY`（hub 转发 agent 时验签）与 `hub/install-hub.sh`
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
- hub 与 agent 即使同机也跑在两个账号下（`probe-hub` / `probe-agent`），不是一个。数据库
  目录 0700 属主 `probe-hub`：agent 是同一份发到全网的代码，读不到库，一个节点侧的问题就
  变不成整支舰队的 token 泄漏。安装器对同名账号先校验再用——已有的同名账号若不是本项目的
  系统账号（系统 uid + nologin），直接报错，不会静默接管别人的用户。
- 换发布源不降低可信度：二进制过的是编进安装器和 hub 的公钥签名，源只能影响"取到哪些字节"，
  影响不了"这些字节是不是本项目签的"。

## 许可

MIT
