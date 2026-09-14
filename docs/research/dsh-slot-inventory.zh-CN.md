# DSH 座位（Slot）全量清单 —— 第三方插件可用性核实

**核实对象（唯一权威 = 源码树）**：`/Users/limeng/DSH/deepseek-harness-dsh-v0.1.5-rc.1`
**版本锚点**：`@deepseek-ai/dsh-root` = `0.1.5-rc.1`（根 `package.json`）
**核实方式**：全仓 `grep` 扫 + 读声明处 + 反证；**未修改任何 DSH 源码或仓库文件**（本文件是唯一新增产物）。
**产出目的**：给下一位实现者一份"这版 DSH 到底开了哪些座位、哪个适合做会话内悬浮面板"的可用清单。

---

## 0. 结论速览（先读这一节）

| # | 问题 | 结论 | 等级 |
|---|---|---|---|
| ① | 座位用什么 API 声明 | **`SlotMap` 接口声明合并 + `ctx.slots.register()` 时 `children` 子表声明**；没有 `defineSlot`/`declareSlot` 这类函数 | [代码证据] |
| ② | 这版 DSH 一共开了几个座位 | **61 个**（非测试；另有 1 个内建 `root`） | [代码证据] |
| ③ | 第三方插件能不能用这些座位 | **能**，且官方第三方模板 `dsh-plugin-template` 已在用 15 个 | [代码证据] |
| ④ | 「会话内悬浮面板」最适合哪个座位 | **`shell.overlay`**（root 级 `list`，加法、不抢位、自带全框浮层） | [代码证据] 为主，见 §5 |
| ⑤ | 前提纠正：这版有没有 `ctx.sidebarRight` | **有。** 该服务真实存在且被 `ui-sidebar-right` 提供 | [代码证据] |
| ⑥ | 最危险的坑 | **`slots.inject()` 对"不存在的座位名"不报错、静默永等**；只有 `register()` 才会抛错 | [代码证据] |

> **给实现者的一句话**：把悬浮面板注册进 `shell.overlay`；名字写错会**静默失败**（无日志无报错），所以落地前必须用 §7 的反证法确认座位名真的在声明处。

---

## 1. 座位声明机制（逐字证据）

这座 DSH **没有** `ctx.slots.declare(...)`、`slots.inject` 作为声明、`defineSlot` 之类的"声明函数"。真实机制是**两段式**：

### 1.1 第一段：类型层 —— `SlotMap` 接口声明合并

座位契约在**类型系统**里声明。核心空表定义在：

**`packages/client/ui-slots/src/index.ts`**（`@deepseek-ai/dsh-client-ui-slots`）

```ts
/** Slot contract table. Owners extend via declaration merging; entries are {@link SlotEntryDef}. */
export interface SlotMap {}
```

每个座位的**拥有者**（owner）用 TypeScript 的 declaration merging 把条目并进去。逐字范例（`packages/client/ui-layout/src/client/index.ts`，`packages/client/ui-layout/src/client/index.ts:91`）：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. ...
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}
```

两条轴由 `SlotEntryDef` 定义（`packages/client/ui-slots/src/index.ts`）：

```ts
/** Slot cardinality: single occupant, ordered list, key-dispatched, or selector-routed chain. */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** Slot data context: global, current-session-optional, or strict session-bound. */
export type SlotScope = 'root' | 'session-maybe' | 'session'
```

### 1.2 第二段：运行时层 —— `register()` 的 `children` 子表

座位真正"活起来"是**持有该位置的组件**在 `register()` 调用里通过 `children` 声明。逐字证据（`packages/client/ui-layout/src/client/index.ts`，`ctx.slots.register({ name: 'root', ... })` 那一次调用）：

```ts
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: 'common',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      store,
    }, AppFrame)
```

要点（逐字来自 `packages/client/ui-slots/src/index.ts` 的 `ChildrenDecl` 注释）：

```ts
/**
 * Child-slot declaration table for register(): keys are the declared (and
 * thereby render-authorized) slot names, values are their runtime dispatch
 * specs. Declaring is claiming: the registering entry becomes the only entry
 * allowed to render these keys.
 */
```

即：**声明 = 认领**。一个座位只有被某个已挂载条目的 `children` 表声明过，才存在。

### 1.3 注册与等待：`register()` / `inject()`

`SlotRegistry` 类在 `packages/client/ui-renderer/src/client/registry.ts:95`（`export class SlotRegistry extends Service`），消费侧 API：

| API | 签名 | 语义 |
|---|---|---|
| `ctx.slots.register(options, component)` | 见 `registry.ts` 的 `register` | 真实注册一个条目，**未声明则抛错** |
| `ctx.slots.inject(key, cb)` | `inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void`（`registry.ts:172`） | 等座位被声明后执行回调 |
| `ctx.slots.provideRoot(contribution)` | `registry.ts:275` | 供 root 级标准 props |

`inject` 的逐字注释（`registry.ts`，`inject()` 方法上方）：

```
   * Install an effect for each declaration lifetime of a slot. The callback
   * runs synchronously when the declaration already exists; otherwise it runs
   * inside the declaring `register()` call after the declaration is committed.
   * Collapse disposes the effect and a later declaration runs it again.
```

### 1.4 第三方插件的最小注册写法（取自 `shell.overlay` 的官方示例字段）

真实存在的官方第三方**插件模板** `dsh-plugin-template-main/src/client/shell-overlay.ts` 逐字：

```ts
export function registerShellOverlay(ctx: Context): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: NAMESPACE, order: 30 },
    ShellOverlayDemo,
  ))
}
```

---

## 2. 全量座位清单表（61 个，穷举）

**穷举方法**：见 §3。表中「声明处」列来自生成的权威目录 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 的 `source:` 字段，我已用脚本逐条回读源文件对应行**校验 61/61 全部命中**（0 缺失 / 0 不匹配），故该目录与源码树同步。

### 2.1 root 级座位（27 个）

| 座位名 | kind | scope | 声明处（包/文件:行） | 渲染处 | 一句话用途 |
|---|---|---|---|---|---|
| `root` | single | root | `client/ui-renderer/src/client/registry.ts:43` | 由 renderer 自行 `renderSlot('root')` | 内建渲染树根洞；**禁止注册**（会顶掉整个框架） |
| `sidebar` | single | root | `client/ui-layout/src/client/index.ts:61` | `ui-layout/AppFrame.tsx` | 整条左栏；已被 `SidebarRoot` 占用（注册=替换） |
| `main` | keyed | root | `client/ui-layout/src/client/index.ts:66` | `ui-layout/AppFrame.tsx` (`MainPanel`) | 中央面板，按侧栏条目 id 派发；`conversation` 为保留 key |
| `rightbar` | single | root | `client/ui-layout/src/client/index.ts:80` | `ui-layout/AppFrame.tsx` | 右栏轨道；已被 `RightbarRoot` 占用 |
| `shell.overlay` | **list** | **root** | `client/ui-layout/src/client/index.ts:91` | `ui-layout/AppFrame.tsx:200` → `.overlayLayer` | **全框浮层（加法、点击穿透）—— 见 §5** |
| `sidebar.brand.mark` | single | root | `client/ui-sidebar/src/client/contract/slots.ts:22` | `ui-sidebar` | 侧栏品牌图标 |
| `sidebar.brand.name` | single | root | `client/ui-sidebar/src/client/contract/slots.ts:27` | `ui-sidebar` | 侧栏品牌名 |
| `sidebar.panellist` | list | root | `client/ui-sidebar/src/client/contract/slots.ts:32` | `ui-sidebar` | 侧栏面板列表（导航行） |
| `sidebar.workspaces` | single | root | `client/ui-sidebar/src/client/contract/slots.ts:39` | `ui-sidebar` | 侧栏工作区区段 |
| `sidebar.settings` | single | root | `client/ui-sidebar/src/client/contract/slots.ts:45` | `ui-sidebar` | 侧栏设置入口区段（下挂 settings.*） |
| `sidebar.footer.action` | list | root | `client/ui-sidebar/src/client/contract/slots.ts:50` | `ui-sidebar` | 侧栏底部动作 |
| `sidebar.workspaces.directoryFlow` | single | root | `client/ui-workspace/src/client/contract/slots.ts:59` | `ui-workspace` | 工作区目录选择流程 |
| `settings.trigger` | single | root | `client/ui-settings/src/client/contract/slots.ts:24` | `ui-settings-general` | 设置入口按钮 |
| `settings.header` | single | root | `client/ui-settings/src/client/contract/slots.ts:30` | `ui-settings` | 设置页头 |
| `settings.action` | list | root | `client/ui-settings/src/client/contract/slots.ts:36` | `ui-settings` | 设置页头动作 |
| `settings.close` | single | root | `client/ui-settings/src/client/contract/slots.ts:42` | `ui-settings` | 设置关闭控件 |
| `settings.section` | list | root | `client/ui-settings/src/client/contract/slots.ts:54` | `ui-settings` | 设置分区 |
| `settings.plugins.tab` | list | root | `client/ui-settings/src/client/contract/slots.ts:63` | `ui-settings` | 插件设置页签 |
| `settings.onboarding` | list | root | `client/ui-settings/src/client/contract/slots.ts:74` | `ui-settings` | 引导区 |
| `settings.general.item` | list | root | `client/ui-settings/src/client/contract/slots.ts:89` | `ui-settings-general` | 通用设置条目 |
| `settings.models.provider-card` | keyed | root | `client/ui-settings-models/src/client/slot-contract.ts:33` | `ui-settings-models` | 模型 provider 卡片 |
| `settings.models.footer` | list | root | `client/ui-settings-models/src/client/slot-contract.ts:38` | `ui-settings-models` | 模型设置页脚 |
| `settings.plugin.item` | keyed | root | `client/ui-settings-plugins/src/client/slot-contract.ts:19` | `ui-settings-plugins` | 单插件配置卡片 |
| `conversation.hero.brand.mark` | single | root | `client/ui-conversation/src/client/contract/slots.ts:162` | `ui-conversation` | 空白会话 Hero 品牌标 |
| `conversation.hero.workspace` | single | root | `client/ui-conversation/src/client/contract/slots.ts:160` | `ui-conversation` | 空白会话 Hero 工作区选择 |
| `conversation.hero.agentPreset` | single | root | `client/ui-conversation/src/client/contract/slots.ts:164` | `ui-conversation` | 空白会话 Hero agent 预设 |
| `conversation.hero.workspace.directoryFlow` | single | root | `client/ui-workspace/src/client/contract/slots.ts:57` | `ui-workspace` | Hero 工作区目录流程 |

### 2.2 session 级座位（31 个）

| 座位名 | kind | scope | 声明处（包/文件:行） | 渲染处 | 一句话用途 |
|---|---|---|---|---|---|
| `main.conversation` | single | session-maybe | `client/ui-conversation/src/client/contract/slots.ts:121` | `ui-conversation` | 会话外壳（main 面板内） |
| `conversation.session` | single | session | `client/ui-conversation/src/client/contract/slots.ts:123` | `ui-conversation` | 严格按会话的会话主体 |
| `conversation.session.header` | single | session | `client/ui-conversation/src/client/contract/slots.ts:125` | `ui-conversation/ConversationSession.tsx` | 会话头（标题/动作/视图导航） |
| `conversation.session.header.lineage` | single | session | `client/ui-conversation/src/client/contract/slots.ts:127` | `ui-conversation` | 面包屑标题替换 |
| `conversation.session.header.actions` | list | session | `client/ui-conversation/src/client/contract/slots.ts:133` | `ui-conversation` | 标题旁动作（升序） |
| `conversation.session.header.utilities` | list | session | `client/ui-conversation/src/client/contract/slots.ts:139` | `ui-conversation` | 右对齐会话工具 |
| `conversation.session.header.corner` | single | session | `client/ui-conversation/src/client/contract/slots.ts:150` | `ui-conversation/ConversationSession.tsx:137` | **头部最右角**，仅一个控件（已被展开按钮占用） |
| `conversation.view` | list | session | `client/ui-conversation/src/client/contract/slots.ts:156` | `ui-conversation` | 会话目标视图（一次渲染一个） |
| `conversation.composer` | chain | session | `client/ui-conversation/src/client/contract/slots.ts:158` | `ui-conversation/ConversationRoot.tsx` | 选择器路由的 composer 替换链 |
| `conversation.input.dock` | list | session | `client/ui-conversation/src/client/contract/slots.ts:166` | `ui-conversation` | composer 卡片上方的全宽条目（已占 3） |
| `conversation.input.overlay` | list | session | `client/ui-conversation/src/client/contract/slots.ts:168` | `ui-conversation/InputBar.tsx:434` → `.overlayAnchor` | **composer 卡片内的浮动条目**（已占 3） |
| `conversation.composer.dock` | list | session | `client/ui-conversation/src/client/contract/slots.ts:170` | `ui-conversation` | 卡片下方环境条目 |
| `conversation.input.left` | list | session | `client/ui-conversation/src/client/contract/slots.ts:172` | `ui-conversation` | composer 工具行左侧紧凑控件 |
| `conversation.input.right` | list | session | `client/ui-conversation/src/client/contract/slots.ts:174` | `ui-conversation` | 提交动作前的紧凑控件 |
| `conversation.composer.bar` | single | session-maybe | `client/ui-conversation/src/client/contract/slots.ts:176` | `ui-conversation` | 常驻 composer 条 |
| `conversation.input.attachments` | single | session-maybe | `client/ui-conversation/src/client/contract/slots.ts:178` | `ui-conversation` | 草稿附件轨/落点 |
| `conversation.input.plan` | single | session | `client/ui-conversation/src/client/contract/slots.ts:184` | `ui-conversation` | composer 内的计划控件 |
| `conversation.input.model` | single | session | `client/ui-conversation/src/client/contract/slots.ts:186` | `ui-conversation` | composer 内的模型选择器 |
| `conversation.approval.detail` | single | session | `client/ui-approval/src/client/contract/slots.ts:37` | `ui-approval` | 审批详情 |
| `conversation.message.images` | single | session | `client/ui-chat/src/client/contract/slots.ts:195` | `ui-chat` | 消息图片渲染 |
| `conversation.chat.node` | keyed | session | `client/ui-chat/src/client/contract/slots.ts:182` | `ui-chat` | 按节点 kind 派发的会话记录渲染（**17 个 key 已占**） |
| `conversation.chat.commandview` | keyed | session | `client/ui-chat/src/client/contract/slots.ts:201` | `ui-chat` | 命令输出视图 |
| `conversation.chat.turnTail` | chain | session | `client/ui-chat/src/client/contract/slots.ts:207` | `ui-chat` | 轮次尾部链 |
| `conversation.chat.assistant-actions` | list | session | `client/ui-chat/src/client/contract/slots.ts:213` | `ui-chat` | 助手消息动作 |
| `conversation.trajectory.images` | single | session | `client/ui-trajectory/src/client/trajectory-contract.ts:98` | `ui-trajectory` | 轨迹图片 |
| `tool.call.toolview` | keyed | session | `client/ui-tool/src/client/contract/slots.ts:26` | `ui-tool` | 按工具名派发的工具视图（**17 个 key 已占**） |
| `tool.call.images` | single | session | `client/ui-tool/src/client/contract/slots.ts:40` | `ui-tool` | 工具结果图片 |
| `tool.view.cordis` | keyed | session | `extensions/ui-cordis/src/client/slots.ts:31` | `ui-cordis` | `cordis_run` 卡片内的可交互区 |
| `rightbar.session` | single | session | `client/ui-sidebar-right/src/client/contract/slots.ts:42` | `ui-sidebar-right` | 按会话的右栏内容 |
| `sidebar.right.pane.tab` | keyed | session | `client/ui-sidebar-right/src/client/contract/slots.ts:50` | `ui-sidebar-right/SidebarRight.tsx` | 右栏单个 tab 主体（已占 3 个 key） |
| `sidebar.right.pane.tab.title` | keyed | session | `client/ui-sidebar-right/src/client/contract/slots.ts:64` | `ui-sidebar-right/SidebarRight.tsx` | tab 标题（已占 3 个 key） |
| `sidebar.right.tab.document` | keyed | session | `client/ui-sidebar-documentpreview/src/client/document/contract.ts:24` | `ui-sidebar-documentpreview` | 按实现 id 派发的文档主体（已占 6 个 key） |
| `sidebar.right.tab.guide` | chain | session | `client/ui-sidebar-right/src/client/contract/slots.ts:75` | `ui-sidebar-right/tabs/guide/GuideBody.tsx:96` | 右栏 guide tab 的链式内容 |
| `sidebar.right.tab.menu.item` | list | session | `client/ui-sidebar-right/src/client/contract/slots.ts:86` | `ui-sidebar-right` | tab 上下文菜单项 |

> 注：§2.1 + §2.2 行数 27 + 34 = 61；其中 `session` 31、`session-maybe` 3、`root` 27（`session-maybe` 3 个：`main.conversation`、`conversation.composer.bar`、`conversation.input.attachments`）。

---

## 3. 穷举方法与反证（怎么保证"没漏"）

### 3.1 全仓扫法

1. `grep -rl "declare module '@deepseek-ai/dsh-client-ui-slots'"` → 65 个文件；逐个提取 `interface SlotMap { ... }` 的**顶层键**（大括号配平）→ 得 90 个键。
2. 比对**生成目录** `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（61 条 + 内建 `root`）。
3. 差集 **恰好 29 个**，逐条核对**全部**是测试夹具命名空间（`test.*`、`chain.*`、`trt.*`、`spec.*`、`dynamic.*`、`t.*`、`resources.*`、`surface.injected`）——即**非产品座位**。反过来「目录有而扫描没有」= **0 条**。

> 结论：**61 + 内建 `root` = 62 是这版 DSH 的完整座位集合**。[代码证据]

### 3.2 生成目录为什么可信

`slot-catalog.ts` 头注明：

```
 * Generated by scripts/gen-client-catalog.ts — do not edit by hand; run
 * `pnpm run gen-client-catalog` to regenerate (freshness-gated by
 * `pnpm run verify-client-catalog` in doc-sync).
```

生成器 `scripts/gen-client-catalog.ts` 内置 **fail-closed 校验**（逐字）：

```ts
      problems.push(`registration into '${registration.key}' (${registration.source}) targets a slot no SlotMap merge declares; either the scan has a blind spot or the registration is dead.`)
```

即：**"注册进一个没有 SlotMap 声明的座位"会在 CI 直接失败** —— 这正面印证了 §1 的机制：**契约在声明处**。

### 3.3 目录与源码树的一致性校验（我实跑）

用脚本回读 61 条 `source:` 的 `文件:行`，检查该行附近是否出现 `'<座位名>'` 字面量：

```
checked 61 missing 0 mismatch 0
```

→ 目录与这棵树**同步**（注：`npx tsx scripts/gen-client-catalog.ts --check` 因仓库未装依赖跑不起来，故改用上述等价的自校验）。

### 3.4 反证（把名字改坏 → 必须找不到）

| 名字 | 命中数 | 判定 |
|---|---|---|
| `shell.overlay` | 9 | 存在 |
| `conversation.session.header.corner` | 14 | 存在 |
| `shell.floating` | **0** | **不存在** |
| `shell.panel` | **0** | **不存在** |
| `shell.dock` | **0** | **不存在** |
| `conversation.floating` | **0** | **不存在** |
| `session.overlay` | **0** | **不存在** |
| `conversation.hero.mode` | **0**（声明处） | **不存在** |
| `conversation.hero.modeActions` | **0**（声明处） | **不存在** |
| `conversation.input.accessory` | **0**（声明处） | **不存在** |
| `conversation.details.tool` | **0**（声明处） | **不存在** |

最后四个是**实测事故样本**：本工作区的第三方插件 `dsh-miniapp`（已构建产物 `lib/client.js`）确实在注册 `conversation.hero.mode`、`conversation.input.accessory`、`conversation.details.tool` —— 而它们在声明处 **0 命中**，即**从未被声明过**。

### 3.5 静默失败的机制（为什么这类错误"没有报错"）

**注册侧会抛错**（`packages/client/ui-slots/src/index.ts`，`SlotCore.register`）：

```ts
  register(options: ErasedOptions, component: unknown): () => void {
    const rec = this.records.get(options.name)
    if (!rec?.spec) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
```

**等待侧不会抛错**（`packages/client/ui-renderer/src/client/registry.ts`，`inject()` 内的 `reconcile`）：

```ts
        const spec = this._core.specDynamic(key)
        ...
        if (spec === undefined) return
```

`key` 未声明 → `spec === undefined` → **直接 return，静默永等**。而 `inject` 的 `@throws` 只列了"座位**已声明**时 callback setup 同步失败"，**没有**"名字不存在"这一项。

> **这就是本插件此前"座位名字存在但契约不在"的事故根因**：`inject` 拿一个不存在的名字，不报错、不警告、日志空白，回调永不执行，于是 UI 永远不出现。[代码证据]

---

## 4. 第三方可用 vs DSH 内部自用

### 4.1 判断依据（三条，按强度排序）

1. **官方第三方插件模板是否在用**：`dsh-plugin-template-main`（非 DSH 仓库内、面向第三方发布）。它用了 15 个座位 → 这些是**官方认可的第三方入口**。
2. **是否有 `declaredBy` 链**：座位能被第三方碰到，前提是其声明者已挂载。目录里的 `declaredBy` 字段给出这条链。
3. **`replaceRisk` 字段**：`none` = 加法（第三方安全）；`shadows-shipped-ui` = 会替换 DSH 自带 UI（第三方**不要**碰）。

### 4.2 官方第三方模板已用的座位（15 个）—— 强证据

来源：`/Users/limeng/DSH/dsh-plugin-template-main/src/client/*.ts` 的 `ctx.slots.inject(...)` 逐字命中：

| 座位 | 模板文件 |
|---|---|
| `shell.overlay` | `shell-overlay.ts` |
| `conversation.composer.dock` | `composer-dock.ts` |
| `conversation.input.dock` | `input-dock.ts` |
| `conversation.input.left` | `input-left.ts` |
| `conversation.input.right` | `input-right.ts` |
| `conversation.session.header.actions` | `header-actions.ts` |
| `conversation.session.header.utilities` | `header-utilities.ts` |
| `conversation.chat.assistant-actions` | `assistant-actions.ts` |
| `conversation.chat.commandview` | `commandview.ts` |
| `sidebar.footer.action` | `sidebar-action.ts` |
| `settings.action` | `settings-action.ts` |
| `settings.general.item` | `general-item.ts` |
| `settings.plugin.item` | `config-card.ts` |
| `settings.plugins.tab` | `plugins-tab.ts` |

### 4.3 分类表

| 类别 | 座位 | 依据 |
|---|---|---|
| **✅ 第三方首选（加法 + 模板在用）** | `shell.overlay`、`conversation.input.dock`、`conversation.composer.dock`、`conversation.input.left`、`conversation.input.right`、`conversation.session.header.actions`、`conversation.session.header.utilities`、`conversation.chat.assistant-actions`、`sidebar.footer.action`、`settings.action`、`settings.general.item`、`settings.plugins.tab`、`settings.plugin.item`、`conversation.chat.commandview` | 均为 `list`/`keyed` 且 `replaceRisk: none`，且模板在用 |
| **✅ 第三方可用（加法、模板未覆盖）** | `conversation.input.overlay`、`conversation.view`、`conversation.chat.turnTail`、`settings.section`、`settings.onboarding`、`settings.models.footer`、`sidebar.panellist`、`settings.models.provider-card`、`sidebar.right.tab.menu.item`、`sidebar.right.tab.guide`、`tool.view.cordis` | kind 为 list/chain/keyed 且 `replaceRisk: none` |
| **⚠️ 第三方可用但需接管/替换（危险）** | `sidebar`、`rightbar`、`rightbar.session`、`sidebar.workspaces`、`sidebar.settings`、`sidebar.brand.mark`、`sidebar.brand.name`、`settings.trigger`、`settings.header`、`settings.close`、`conversation.session`、`conversation.session.header`、`conversation.session.header.corner`、`conversation.session.header.lineage`、`conversation.composer.bar`、`conversation.input.attachments`、`conversation.input.plan`、`conversation.input.model`、`conversation.hero.*`、`main.conversation`、`conversation.approval.detail`、`conversation.message.images`、`conversation.trajectory.images`、`tool.call.images`、`conversation.chat.node`、`tool.call.toolview`、`sidebar.right.pane.tab(.title)`、`sidebar.right.tab.document`、`conversation.composer` | kind=`single` 或 `replaceRisk: shadows-shipped-ui`；注册=替换自带 UI（`single` 在同优先级重复注册会**抛错**） |
| **⛔ 禁止注册（DSH 内部）** | `root`、`main` | `root` 声明处逐字警告「DO NOT register here」；`main` 是 keyed 但承载中央面板且被 `retainMainPanels` 跟踪 |

`root` 的声明注释逐字（`packages/client/ui-renderer/src/client/registry.ts`）：

```
     * DO NOT register here. This is a single slot, so a second entry does not
     * sit beside the frame — it shadows it, and a dynamically registered entry
     * is assigned a lower priority than the shipped one, which makes it the
     * winner: the page would render your component alone, with every seat the
     * frame declares gone. For a surface of your own that floats over the whole
     * app, register into `shell.overlay` instead (a list slot: additive, and
     * click-through until your entry opts into pointer events).
```

> 注意：DSH 自己在 `root` 注释里就**点名推荐 `shell.overlay` 做"浮在整个 app 之上的自有表面"**。

### 4.4 关于 `single` 的硬约束（会抛错）

`packages/client/ui-slots/src/index.ts`：

```ts
      case 'single': {
        const occupant = rec.entries.find(e => (e.options.priority ?? 0) === priority)
        if (occupant) throw new Error(`single slot "${options.name}" already has a registration ${occupantHint(occupant)}`)
```

→ `single` 座位在同优先级再注册**直接抛错**；且 `@deepseek-ai/dsh-client-ui-dockkit` README 明确自称 **"Internal engine ... not as a stable API"**，故任何依赖 dock/float 引擎的做法对第三方是**不稳定契约**。

---

## 5. 重点回答：哪个座位最适合"会话内悬浮面板"

### 5.1 候选逐个评估

| 候选 | 能否浮在会话上方 | 自带定位/尺寸 | 自带拖拽 | 会不会抢 DSH 的位 | 综合 |
|---|---|---|---|---|---|
| **`shell.overlay`** | ✅ **能**：`position:absolute; inset:0; z-index:20`，在**所有列之上、滚动容器之外** | ✅ 条目**自己**定位（层只给全框坐标） | ❌ 无（需自实现） | ❌ **不抢**：`list` 加法、唯一 `occupants: []` 空位、`replaceRisk: none` | **★ 推荐** |
| `conversation.input.overlay` | ⚠️ 只能"composer 卡片内"浮动：锚点是 `position:absolute; inset:0 0 auto; height:0` | ⚠️ 只能贴着卡片上沿 | ❌ | ⚠️ 已占 3（命令面板/slash 菜单/反馈弹窗），会**视觉冲突** | 不适合全局面板 |
| `conversation.session.header.corner` | ❌ 头部内一个控件位 | ❌ | ❌ | ⚠️ `single`，已被 `ExpandButton` 占用 | 不适合 |
| `rightbar` / `rightbar.session` | ⚠️ 是"栏"不是"浮层"：是**轨道列**（`gridTemplateColumns` 第三列） | ⚠️ 宽度由 layout 解算 | Δ dockkit 有 float，但**内部不稳定 API** | ⚠️ `single`，已被 `RightbarRoot`/`RightbarSeat` 占用 | 见 §5.4 |
| `sidebar.*` | ❌ 左栏 | ❌ | ❌ | ⚠️ 多为 `single` 已占 | 不适合 |
| `conversation.view` | ❌ 会话视图（一次一个） | ❌ | ❌ | ⚠️ 已占 2 | 不适合 |
| `*corner*` / `*floating*` / `*panel*` / `*dock*` 其他 | — | — | — | — | **不存在这些名字**（§3.4 反证 0 命中）；唯一 `*dock*` 是 composer 下方的 ambient 条，不是浮层 |

### 5.2 `shell.overlay` 的逐条代码证据

**(a) 声明（`client/ui-layout/src/client/index.ts:91`）** 逐字：

```ts
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. Deliberately generic and unowned by any feature: a badge, a
     * toast stack or a status pill all belong here, and entries order among
     * themselves. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     *
     * This is the additive seat for a frame-wide surface of your own: a fresh
     * `id` is added beside the shipped entries instead of replacing them.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
```

**(b) 渲染处（`client/ui-layout/src/client/AppFrame.tsx:200` 与 `:230`）** 逐字：

```tsx
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])
```
```tsx
      <div className={css.overlayLayer} data-shell-overlay>
        {overlays}
      </div>
```

**(c) 定位与层级（`client/ui-layout/src/client/AppFrame.module.css`）** 逐字：

```css
.overlayLayer {
  position: absolute;
  inset: 0;
  z-index: 20;
  pointer-events: none;
}

.overlayLayer > * {
  pointer-events: auto;
}
```

→ **层本身不提供条目布局**（只有全框 inset），条目**自己**负责定位；层点击穿透，条目自动 opt-in 指针事件（`> *` 规则）。

**(d) 零占用**：目录 `occupants: []`，`replaceRisk: 'none'` —— DSH 自带**没有任何插件注册此处**，是纯加法空位。

**(e) 注册选项**（目录 `registerOptions`）：`id`（必需，你的 cell key）、`order`（可选，升序）、`label`（可选）。

### 5.3 推荐与理由

> **推荐：`shell.overlay`。**
>
> **理由**：
> 1. **语义就是为它写的** —— 声明原文：`Frame-wide floating layer, above every column and outside their scroll containers`，且 DSH 在 `root` 的注释里主动引导 "For a surface of your own that floats over the whole app, register into `shell.overlay` instead"。[代码证据]
> 2. **不抢位**：`list` + `occupants` 空 + `replaceRisk: none`，加你的 `id` 就是加法，不会顶掉任何 DSH UI。[代码证据]
> 3. **自带所需的三件事**：浮在所有列之上（`z-index:20` + 全框 inset）、滚动容器之外、条目自定位（你要的"自己的定位与尺寸"）。[代码证据]
> 4. **有第三方先例**：官方插件模板 `shell-overlay.ts` 与工作区内的 `dsh-miniapp`（`lib/client.js` 6 处引用）都在用。[代码证据]
> 5. **官方 AI 指南也这么教**：`packages/preset/agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md` 逐字：
>    - "For toasts, status notices, and frame-wide overlays, **query `shell.overlay` first**; observe its pointer-events and ordering rules."
>    - "When the selected target is a global overlay Slot, **decide whether the UI should be draggable**, how the user shows and hides it, and which existing layers it must cover or remain below."[代码证据]

**必须自己补的两件事（`shell.overlay` 不提供）**：
- **拖拽**：层与 DSH 都**不提供**拖拽能力 → 需要自己实现（`pointerdown/move/up` + 自己的 `transform`）。`ui-dockkit` 有浮窗引擎，但其 README 自称内部不稳定 API，**不建议**第三方依赖。[代码证据 + 推断]
- **定位**：层只给全框坐标，条目自己要写 `position: fixed/absolute` + 具体锚点。

### 5.4 一个必须知道的取舍：`shell.overlay` 是 **root 级**，拿不到 `sessionId`

`shell.overlay` 的 `scope: 'root'`，因此条目只拿到 `GlobalStandardProps`，**不含** `sessionId`/`useSession`。对照 `packages/client/ui-session/src/client/index.ts` 逐字：

```ts
  interface GlobalStandardProps {
    /** Session list and current selection. */
    useSessions: UseSessions
    /** Pending user interaction presented by a Session-scoped UI consumer. */
    useSessionPendingInteraction: UseSessionPendingInteraction
  }

  interface SessionStandardProps {
    /** Current Session lifecycle and control state. */
    useSession: SessionSnapshotSelector
    /** Current Session identity. */
    sessionId: SessionId
    /** Host-computed projection values addressed by projection key. */
    useProjection: UseProjection
  }
```

且 `SessionStandardProps`/`SessionMaybeStandardProps` 只注入给 `scope === 'session'` / `'session-maybe'` 的座位（`packages/client/ui-slots/src/index.ts` 的 `PropsRuntime` 定义）：

```ts
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
GlobalStandardProps
```

**后果**：`shell.overlay` 里的组件要自己从 `useSessions` 读"当前会话"，而不是靠框架注入的 `sessionId`。这条路是通的 —— `useSessions` 的类型是 `SnapshotSelectorHook<SessionListState>`（`packages/client/ui-session/src/client/index.ts:28`），而该快照带 `current` 字段（`packages/api/session-controller/src/client/sessions/service.ts:69`）逐字：

```ts
export interface SessionListState {
  /** Host-list order; addressed breadcrumb-only rows are excluded. */
  ids: SessionId[]
  /** Host rows plus the current addressed subagent route used by navigation. */
  byId: Record<SessionId, SessionSummary>
  current: SessionId | undefined
```

即：`useSessions(s => s.current)` 即可拿到当前会话 id。这是**可用但需自行接线**的一点。[代码证据]

**若必须严格绑定会话**（需要 `sessionId` 与 `useSession`）：
- 选 `conversation.input.overlay`（`session` 级、加法、`replaceRisk: none`）—— 但只能浮在 **composer 卡片内**，不是全屏浮层，且已占 3 个条目（命令面板、slash 菜单、反馈弹窗），面板太大/居中的话会打架。[代码证据]
- 或用 dockkit 的右栏浮窗（`ctx.sidebarRight.float(tabId, rect?)`，`session` 级、可传自算 `FloatRect`）—— 但那是**右栏体系**（需要注册 tab 类型 + `sidebar.right.pane.tab`），且依赖被标为内部不稳定的 dockkit。[代码证据]

**建议**：做全局面板用 `shell.overlay` + `useSessions` 自取当前会话；若面板必须"跟着某个会话且不能被切走"，再考虑 `conversation.input.overlay`。

### 5.5 实现骨架（基于上述证据，非猜测 API）

```ts
// 座位名与选项来自 shell.overlay 的声明与目录 registerOptions: id(必需)/order/label
ctx.slots.inject('shell.overlay', () => ctx.slots.register(
  { name: 'shell.overlay', id: 'my-plugin-panel', order: 100 },
  MyFloatingPanel,   // 组件自己写 position:fixed + 自己的拖拽
))
```

组件内注意（**两层事实，别混**）：
- CSS 里确有 `.overlayLayer > * { pointer-events: auto }`，所以**直接子元素**被自动放行；
- 但官方模板仍在自己根元素上**显式写 `pointer-events: auto`** 并注明「层本身点击穿透，条目自行 opt-in 指针事件」（`dsh-plugin-template-main/src/client/styles.ts` 的 `.dtpl-overlay` 规则）。**照模板做最稳**：显式声明，别依赖 `> *` 选择器（一旦你的组件外面包了一层 wrapper，`> *` 就不再命中交互元素）。

另外两条模板给出的实用惯例（`dsh-plugin-template-main/src/client/styles.ts`）：
- 定位用 `position: fixed`（模板取右下角 `right:16px; bottom:16px`）—— 因为层只是 `inset:0` 的全框层。
- 颜色走主题变量 `--dsw-alias-*`（如 `--dsw-alias-bg-layer-3`、`--dsw-alias-label-primary`），深浅色自动适配；样式通过 `<style data-plugin data-plugin-css>` 注入，由 client-modules 的 `claimStyles` 回收。

---

## 6. 前提纠正：`ctx.sidebarRight` 在 v0.1.5-rc.1 **是存在的**

任务背景说"这版 DSH 没有 `ctx.sidebarRight`，于是插件打不开右侧栏与悬浮窗"。**核实结果：该前提不成立。**

**(a) 服务确实被提供**（`packages/client/ui-sidebar-right/src/client/index.ts:109`）逐字：

```ts
  const disposeService = ctx.reflect.provide('sidebarRight', controller)
```

**(b) 类型面确实合并进 Context**（同文件 `:78`）逐字：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Right-Sidebar navigation and presentation face. */
    sidebarRight: SidebarRightController
    /** Right-Sidebar tab-type registry (stage one of a tab type's registration). */
    sidebarRightTabs: SidebarRightTabRegistry
  }
}
```

**(c) 有活的第三方消费者**：`packages/client/ui-chat/src/client/apply.ts` 的 `inject` 数组含 `'sidebarRight'`，并调用 `ctx.sidebarRight.openResource(url, ...)`。[代码证据]

**(d) 浮窗能力确实在该服务上**（`packages/client/ui-sidebar-right/src/client/service.ts:195`）逐字：

```ts
  float(tabId: TabId, rect?: FloatRect): void
```

`FloatRect` 定义（`packages/client/ui-dockkit/src/contract/types.ts:50`）：

```ts
export interface FloatRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
```

→ **`float` 接受调用方自己算的 rect**，即第三方**可以**自己决定浮窗位置与尺寸。[代码证据]

**那为什么插件此前"打不开"？** 最可能的解释（[推断]，依据 §3.5）：插件注册的座位名**从未被声明**（如 `conversation.hero.mode`、`conversation.input.accessory`、`conversation.details.tool` 在声明处 0 命中），而 `slots.inject` 对未声明名**静默永等** —— 表现为"什么都没发生、没有任何报错"。

**建议**：先确认那版插件打的到底是不是 `sidebarRight`；若是座位名问题，按 §3.4 反证法逐个核对座位名。`sidebarRight` 是否在**运行中的 app.asar** 里可用，需另行以 asar 为权威复验（见已存在的 `rightbar-feasibility.zh-CN.md`，其结论为「可用」）。本条只对**源码树**负责。

---

## 7. 给下一位实现者的操作清单

1. **要用悬浮面板 → 用 `shell.overlay`**（`id`/`order` 两个选项，组件自定位自适应尺寸）。
2. **落地前必做反证**：`grep -rn "'<座位名>'" packages/` 必须命中**声明处**（在 `interface SlotMap {` 内），而不是只命中测试或文档。
3. **警惕静默失败**：`slots.inject` 对不存在的名字不报错。若 UI 不出现且日志干净，**第一个怀疑座位名拼错/不存在**，而不是样式问题。
4. **不要碰 `root` / `main`**；不要在 `single` 座位同优先级重复注册（会抛错）。
5. **不要依赖 `@deepseek-ai/dsh-client-ui-dockkit`**（自称内部不稳定 API）。
6. **拖拽要自己实现**：`shell.overlay` 层与 DSH 都不提供。

---

## 8. 证据等级与未取证项

**本文标注**：`[代码证据]` = 在源码树读到并给出文件 + 可搜索文本；`[推断]` = 由代码证据推出；`未取证` = 没有找到证据。

**未取证 / 需另行核实**：

| 项 | 状态 |
|---|---|
| 运行中的 `app.asar` 与这棵源码树是否位级一致 | **未取证**（本文只对源码树负责；`rightbar-feasibility.zh-CN.md` 走的是 asar 通道） |
| `npx tsx scripts/gen-client-catalog.ts --check` 的绿 | **未取证**（本仓库未装依赖，命令报 `ERR_MODULE_NOT_FOUND: typescript`）；已用等价自校验替代（§3.3） |
| 目标插件此前具体注册了哪些名字、"打不开"的确切原因 | **部分未取证**：已确认 `dsh-miniapp/lib/client.js` 注册了 4 个不存在的座位名；但"当时那次失败"的确切调用栈未取 |
| `shell.overlay` 条目与 DSH 自带层级是否在所有主题下都够高 | **未取证**（只读到 `z-index: 20`，未穷举全部层叠上下文） |

**核实边界声明**：本次核实**只读**，未修改 DSH 源码或任何仓库文件；新增产物仅本文件。

---

## 附录：**运行时**座位与服务（2026-09-14 实测，来自 Inspect Provider）

> 上文是**源码级**穷举（61 个座位）。本附录是**活着的应用**里的实测结果 —— 两者可能不一致（源码里有、组合里没挂），而**实现必须以后者为准**。
> 取法：`cordis_inspect_query(platform=client, provider=Slots|Service)`（只读，未改任何东西）。

### 1. 活服务目录（关键：有些服务**不在**）

```
layout · locale · sessions · slots · theme · timer · uiWorkspace · workspaces
```

**`sidebarRight` 与 `sidebarRightTabs` 都不在其中** —— 尽管源码里有 `ui-sidebar-right`
（`provide('sidebarRight')`）、安装包 asar 里也有该包代码。⇒ **结论：不是"这版没这个能力"，
而是"提供它的那一行没有被挂进这个组合"**。

补充：`layout` 这版暴露的是 **`openRightbar(track, fullscreen)` / `closeRightbar()`**，
**没有** `openDetails` / `closeDetails`。

### 2. 活座位树里与"会话内呈现"有关的座位（逐字取自 inspect 输出）

| 座位 | kind | scope | replaceRisk | 现状 | 用途（官方原文） |
|---|---|---|---|---|---|
| `shell.overlay` | list | root | **none** | **空** | Frame-wide floating layer, above every column and outside their scroll containers |
| `rightbar` | single | root | shadows-shipped-ui | — | The right column: a track the centre makes room for, or nothing |
| `rightbar.session` | single | session | shadows-shipped-ui | — | Session content selected by the root-scoped right Sidebar controller |
| `sidebar.right.pane.tab` | **keyed** | session | **none** | **none taken yet** | One tab's body, dispatched with the `id` of the type in force for `tab.kind` |
| `sidebar.right.pane.tab.title` | **keyed** | session | **none** | **none taken yet** | A tab's title as its chip (and a floating panel's header) shows it |
| `sidebar.right.tab.menu.item` | list | session | none | 空 | Extra items at the end of one tab's actions menu |
| `conversation.view` | list | session | none | 已被本插件用 | Registered Conversation target Views |
| `conversation.session.header.utilities` | list | session | none | 空 | Right-aligned Session utilities |
| `conversation.session.header.actions` | list | session | none | 空 | Title-adjacent Session actions |
| `conversation.input.overlay` | list | session | none | 空 | Floating entries rendered **inside the resident composer card** |
| `conversation.input.dock` / `conversation.composer.dock` | list | session | none | 空 | 输入卡片上方 / 下方 |
| `sidebar.footer.action` | list | root | none | 空 | Optional actions beside Settings |
| `sidebar.panellist` | list | root | none | 空 | Global panel icons |
| `tool.call.toolview` | keyed | session | shadows-shipped-ui | 部分占用 | Keyed atomic Tool call view |
| `root` | single | root | shadows-shipped-ui | — | 官方注释：**DO NOT register here** |

### 3. 对"会话内悬浮/并列"的直接结论

- **悬浮**：用 **`shell.overlay`**（list、空、replaceRisk none）⇒ **不需要任何服务**。
  这正是本次修复采用的路：自绘浮窗自带几何（夹取/拖拽/缩放手柄），只依赖这个座位。
- **并列**：座位 `sidebar.right.pane.tab`（keyed、**无人占用**）在，且 `ctx.layout.openRightbar(track, fullscreen)` 在
  ⇒ **可以绕开缺失的 `sidebarRight` 服务**：直接注册 tab 正文 + 调 `openRightbar` 打开右列。
  这是本次修复**没有**动的部分，但它是这条需求的下一手。
- **陷阱复述**：`ctx.slots.inject(name, cb)` 对**未声明**的座位名**静默永等**（不抛错、不警告）。
  本插件历史上注册过 `conversation.hero.mode`、`conversation.input.accessory`、`conversation.details.tool`，
  这些在声明处均 **0 命中** ⇒ "UI 不出现且毫无报错"的成因。
