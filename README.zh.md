# dsh-miniapp

DeepSeek Harness 的「小程序」—— 由 AI 生成、自包含的单文件网页小工具，发布一次，随处可用。

一个小程序 = **一个自包含的 HTML 文件**（CSS 与 JavaScript 内联，第三方库走 CDN）。Agent 把它写出来，你点一次「发布」，从那一刻起它就是你随时能打开的工具。

移植自 [NomiFun Desktop](https://github.com/nomifun/nomifun-desktop) 的「小程序」功能（v3 统一会话版本）。这是**移植**而不是复刻：产品闭环沿用原版，实现按 DSH 的插件契约重写。

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.2-rc.1` |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | 全平台（纯 ESM；无原生代码，加载时不联网） |
| Client half | Web UI（`dsh web`），含 DSH Desktop |

## What it does

注册十个模型可见的工具，以及一个客户端面板：

- **工具** —— `miniapp_create`、`miniapp_list`、`miniapp_get`、`miniapp_iterate`、`miniapp_read_source`、`miniapp_write_source`、`miniapp_publish`、`miniapp_delete`、`miniapp_validate`、`miniapp_import`。
- **面板** —— 全屏的库页面与运行页，入口是侧栏「设置」那一行最右边的图标。
- **composer 模式** —— 空白会话上有一枚「小程序」chip 和一条模板面板（12 个模板、5 个意图分类，每张卡都是真的在跑的沙箱预览）。选中模板会把一句可编辑的话写进输入框；「直接创建」则不过模型，直接拿模板正文建一个。
- **五个地方跑小程序** —— 全屏面板、浏览器新标签、本会话页签（与「对话」「轨迹」并排）、右侧栏、右上浮窗。五处复用**同一个**沙箱运行页，任意一处都能一键切到另外四处（标题栏的小程序栏 ⋮ 菜单、或运行页右上角的布局按钮）。

  > **两条右栏通道都认。** 新版 DSH 有 `sidebarRight` 服务（带 tab 与原生浮起）；本机这一版是 **0.1.2-rc.1**，它没有那个服务，右栏是**另一套** —— 槽位 `details` + `ctx.layout.openDetails()`。插件启动时探测：有 `sidebarRight` 就用它（能力更全），没有就退到 `details`，两条都没有才如实失败（一条 toast，不假装切过去了）。浮起同理：有 `sidebarRight.float()` 交给 DSH 画；只有 `details`（该槽位只有开/关两态、没有浮起）时由插件**自绘窗口外壳**——只画标题栏、拖动、缩放、层级，**内容仍是同一份** `MiniAppRightbarPane`。

  > **`details` 是 `kind: "single"` 且已被 DSH 的 `DetailsPanel`（工具详情）占着**，所以接手这一格会**顶掉工具详情面板** —— 这是该槽位的固有代价，不是配置项。插件只在没有 `sidebarRight` 的宿主上才登记它，卸载时按事实收回。

存储是物理分离的两层：Agent 编辑的工作副本，与运行页直出的已发布快照。**改完不会自动生效**，要点「发布」。

模型可见的行为：每一次工具调用与结果都会进会话日志，整条链路可从日志重建。已发布文档由能力 URL `/plugins/dsh-miniapp/serve/{id}` 直出，装在 iframe 沙箱里（不含 `allow-same-origin`）。

## Install

```sh
cd dsh-miniapp
pnpm pack
dsh plugin --profile web add ./dsh-miniapp-0.3.0.tgz
```

装完**重启 DSH** —— bundle 层的变更在重启时生效。之后侧栏「设置」那一行的右端会出现小程序图标。

卸载：

```sh
dsh plugin --profile web remove dsh-miniapp
```

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `{DSH_HOME}/miniapp` | 索引、工作副本与已发布快照的位置 |

配置由 `lib/index.js` 里的 Schemastery `Config` schema 校验；没有硬编码的可调参数。在 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-miniapp
  config:
```

## Development

```sh
pnpm test                       # 122 条：存储、宿主路由、客户端契约
pnpm pack                       # 打出可安装的 tarball
```

验证是分层的 —— 核心逻辑、宿主集成、客户端契约（都是 `node --test`），外加一次针对一次性 profile 的真实进程跑。架构、这个插件绕过的 DSH 契约、以及完整验证记录见 [`docs/design.zh-CN.md`](docs/design.zh-CN.md)。

## License

[MIT](LICENSE) © 2026 gpmlimeng-cyber。功能设计来自 Apache-2.0 的 [nomifun-desktop](https://github.com/nomifun/nomifun-desktop)。
