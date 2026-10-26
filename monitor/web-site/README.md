# monitor-web-site

hub 的公开状态页，也是 hub 唯一内置、唯一使用的前端主题。

React + Vite + shadcn/ui，黑白配色。

本目录是 hub 的**构建期输入**：`npm run build` 产出 `dist/`，hub 的 `build.rs` 在编译时把它同步到
`target/theme/dist/` 并用 rust-embed 嵌进二进制。改这里的源码后重新 `make hub` 即生效，不需要打包
发布，也没有任何安装/切换/更新的入口——hub 里不存在主题市场。

## 开发

页面只读公开数据。开发服务器直接拿一个现成的 hub 当数据源，要求它开着公开状态页：

```bash
npm ci
# Vite 将 /api 与 WebSocket 代理至这个 hub
MONITOR_HUB=https://hub.example.com npm run dev
```

不设 `MONITOR_HUB` 时代理至 `http://127.0.0.1:9911`。

构建产物位于 `dist/`。提交前运行 `npm run build && npm run lint && npm test`。

`npm test` 校验数字格式化、坐标轴与时间刻度，以及实时指标的输入边界。没有测试框架，Node 自己剥掉
类型，失败时退出码非零。

## 页面契约

页面是纯静态 SPA，只能依赖下列同源接口：

| 接口 | 用途 |
|---|---|
| `GET /api/me` | 站点名、登录状态、公开页开关、历史保留天数 |
| `GET /api/nodes` | 节点列表、实时指标和累计流量 |
| `GET /api/nodes/{id}/metrics` | 历史指标和延迟记录 |
| `GET /api/ws` | 每 2 秒推送一次节点快照的 WebSocket；带 `?gzip` 时每帧 gzip 后以二进制消息发出 |

`metrics` 的三个查询参数都可省：

- `hours=N` 窗口宽度。**上限是 hub 的保留天数**（`/api/me` 的 `history_days`），登录与匿名相同，超出
  静默 clamp，所以档位要按它生成。7 天以内取分钟明细，更宽取每小时的汇总
- `points=W` 调用方画得下的点数，只会让 hub 抽得更稀，不会更密
- `series=metrics|ping` 只取要画的那一半，省掉的那半原本占响应的三分之一到三分之二

探测曲线的名字在响应的 `probes` 里随样本一起下发，匿名可读，所以画延迟图不需要第二个请求，也不
需要管理员身份。

整个窗口的丢包率在响应的 `loss` 里，按探测 id 给出百分比，没丢包的探测不出现。**不要拿样本行里
的 `loss` 自己平均**：那一个是所在桶的百分比，除数已经丢了，而各桶样本数天然不等——窗口首尾两桶
本来就是残缺的，探测启停、节点掉线、agent 跳过一轮都会再造几个。十三次里丢一次，平均桶百分比会
算出 50%。

匿名访问 `GET /api/nodes` 仅返回 `public=1` 的节点，响应中不含 `ip`、`hostname`、`remark`。字段定义以 hub 的 `monitor/src/api.rs` 为准。

未知路径回落到本页面的 `dist/index.html`，客户端路由可用。`/admin/*` 由 hub 内置后台接管，不属于本页面的契约。

本页面用 `/node/{id}` 作为详情页。hub 的回落对它够用，但**hub 前面若有按路径做正向白名单的反代
或 WAF，得把这个前缀放行**：从列表点进去只是 pushState，边缘看不见，刷新详情页才会真的请求
`/node/{id}`，症状是「点进去正常，一刷新就被拦」。
图标 `/favicon.svg` 和 `/apple-touch-icon.png` 同样要放行，后者被拦时 iOS 收藏和添加到主屏幕都没有图标。

## 遗留文件

`theme.json` 仍在用：`src/lib/config.ts` 从它取 `short`（`/themes/{short}/config` 这条路径）和
`config` 里各项的默认值。主题市场已移除，hub 不再用它挑选或下载主题。

`preview.png` 是主题市场时代的手册缩略图，构建不再复制，仅作文档留存。

## 许可

MIT
