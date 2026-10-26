# probe-hub

hub：管理后台、API 与公开页宿主。整个仓库是单仓库（monorepo），hub、agent 与公开页一起维护；
总览、安装与发布流程见仓库根目录的 `README.md`。

上游的「主题市场 / 主题开发」已整体移除，见下方差异说明。

## 特性

- 实时监控：秒级实时数据展示
- 轻量高效：Rust 语言构建，低资源占用，极简高效
- 自托管：完全掌控数据隐私，部署简单
- 通知：节点掉线、流量、到期与登录，推送到 Telegram 或自定义 Webhook

## 组成

| 目录 | 说明 |
|---|---|
| `monitor/` | hub：后台、API、公开页宿主（Rust + axum + SQLite） |
| `agent/` | Linux agent（独立二进制，WebSocket + JSON-RPC 2.0 上报） |
| `monitor/web-admin/` | 管理后台前端（Vite + React），构建期嵌入 hub |
| `monitor/web-site/` | 公开状态页主题（Vite + React），构建期嵌入 hub |

```
agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  hub (axum + SQLite)  ──▶  后台 + 状态页
```

## 构建

```bash
make hub      # 后台前端 + 主题 + hub 二进制（三者顺序自动编排）
make agent    # 采集端
make check    # cargo check + 两个前端的 lint
make test     # cargo test + 前端测试
```

两个前端都是构建期输入：`cargo build` 会先确保它们的 `dist/` 是最新的，再由 rust-embed 嵌入
二进制。改完 `web-site/` 或 `web-admin/` 后重新 `make hub` 即生效——不需要发版、不需要改 pin、
也不需要联网。

## 与上游的差异（个人 fork）

- **主题市场已整体移除**：没有主题上传、安装、更新、删除、预览，也没有 `/api/themes*` 与
  `--themes` 参数。公开页固定使用 `monitor/web-site/` 那一份内嵌主题，管理面板不再有「主题」页。
- **构建不联网**：默认主题从本仓库源码构建后嵌入，不再按 `web-theme.pin` 从 GitHub Release 下载。
- 相应地，`tar`/`flate2` 里的解压链路只保留公开 WebSocket gzip 帧所需的那部分，主题包的 tar.gz
  解压代码及其依赖已删除。
