# agent-teams 的「悬浮 / 并列 / 收缩为悬浮按钮」是怎么做的 —— 以及小程序该怎么借鉴

> 版本锚点：`@nanmicoder/dsh-agent-teams@0.1.17-rc.1`（已安装于
> `~/.dsh/profiles/desktop/node_modules/@nanmicoder/dsh-agent-teams/`）；宿主为 DSH `0.1.5-rc.1`（`/Applications/DSH Desktop.app/Contents/Resources/app.asar`，173 MiB）。
> dsh-miniapp 快照：`lib/client.js` **≈6890 行**（t24 正在并发修改同一文件：本次写作期间
> 6883 → 6890，**行号每次都在漂**）→ 本文对小程序侧的行号一律写成 `≈`，**请以标识符**
> （常量名 / 函数名 / 座位名 / CSS 字符串）**为准**；agent-teams 侧不受影响，那边是精确行号。
> 全程只读：未改 agent-teams、未改 dsh-miniapp 任何代码（本笔记除外）；**未做运行时观察**
> （`cua-driver` 未安装，`screen_observe` 失败）→ 所有 UI 行为结论都是**读码得出**，不是观察得出。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| **三种形态是三套渲染吗？** | **不是。** 一个 `ActivityPanel` 组件、两个判据：`expanded` 决定画**面板**还是**角标**（`3010-3018`）；面板内部再由 `layout.mode`（`docked` / `floating`）决定**并列**还是**悬浮**（`2998-3001`、`3003-3008`）。形态是**状态**，不是组件。 |
| **并列（docked）怎么做的？** | 右列落位 + **用 CSS 给会话列加 `padding-right`**：`document.documentElement` 挂 `data-agent-teams-panel-open` 并设 `--agent-teams-panel-shift`（`2790-2808`），插件注入的 CSS 命中 `[data-phase=active]`（`563`）。**它不占布局轨道**，也没有用任何 DSH 布局 API 去开一列。 |
| **悬浮（floating）怎么做的？** | 同一个 `<aside>`：`transform: translate3d(x,y,0)`（`3007`）+ 自绘 `pointerdown/move/up` 拖拽与三根缩放手柄（`2932-2997`、`3109-3140`）。`docked ⇄ floating` 只是 `commitLayout` 换一个 `mode`（`2998-3001`），不重挂 DOM。 |
| **收缩为悬浮按钮怎么做的？** | 同一个组件里 `!expanded` 时渲染 `CollapsedBadge`（`2026-2044`，圆角胶囊 + 忙碌点 + 计数）；点它 → `setOpenOwner(current); setOpen(true)`（`3014-3018`）恢复。另有**第二条恢复路**：会话内卡片派发 `agent-teams:open-panel` 窗口事件（`472-479` → `2825-2849`）。 |
| **状态存在哪？** | **只有几何**进 `localStorage`（版本化 key `dsh-agent-teams:activity-panel:v1`，`1732`、`2741-2743`）；`open / openOwner / autoOpened` 等**只在 React 内存**里 → 刷新后**必定回到角标态**。业务数据不在客户端：1s（热）/5s（探活）轮询宿主 `/plugins/dsh-agent-teams/state`（`282`、`289`、`291`、`2809-2824`）。 |
| **它依赖哪些 DSH 原语？** | 只有**一个槽位** `shell.overlay`（`3684-3690`）+ 服务 `uiConversation / slots / sessions / locale / modelDirectories / layout`（`3647-3654`）+ 两个**DOM 选择器**（`[data-shell-overlay]`、`[data-phase='active']`，`2745`/`2747`）+ 自己注入的 `<style>`（`566-570`）。**没用** `uiWorkspace`、`inputActions`、`rightbar`/`openRightbar`、dockkit。 |
| **DSH 自己有没有原生形态？** | **有，而且是另一套。** `rightbar` / `rightbar.session` 是真实声明的右列座位（`name: "rightbar"` 在 asar 里 1 处命中），面板有 `push`（占轨道、会话让位）/ `fullscreen` 两形态，两个控件（形态切换 + 折叠）挂在 tab 条末端，折叠后的回到 `conversation.session.header.corner` 的展开按钮；插件侧 API 是 `ctx.sidebarRight.isExpanded/toggleExpanded/split/float(tabId, rect?)/dock(paneId)/openTab/openResource`。**布局与浮窗的精算属于 `@deepseek-ai/dsh-client-ui-dockkit`，对插件只暴露 `ctx.sidebarRight` 那几个动作。** |
| **小程序现在差什么？** | ① 右侧栏那一面**当前打不开**：`RIGHT_PANEL_SLOT = "details"` 是幽灵座位、`layout.openDetails()` 在这个 DSH 版本**不存在**（`design.zh-CN.md:146,156`，我复核过 asar：`name: "details"` **0 命中**）；② **没有收缩态**：关掉就是消失，没有"收成一枚按钮"的中间态；③ 浮窗几何只在内存；④ 三浮层是"关掉另外两个"的互斥开关，不是**单一 mode**，所以没有"并列 ⇄ 悬浮"的原地切换。 |

**一句话**：agent-teams 的做法是「**一个 `shell.overlay` 里的面板 + 一个 mode 字段 + 一个角标分支 + CSS 挤会话列**」，代价是它自己把拖拽、夹取、几何持久化、自动展开/收起全写了一遍（约 600 行）；而 DSH 其实**已经内置了**同一套语义（dockkit + sidebar-right），只是插件侧只开放了 `ctx.sidebarRight` 的少数动作。

---

## 1. agent-teams 注册了什么（槽位与 DOM）

### 1.1 唯一的面板槽位：`shell.overlay`

`lib/client.js:3684-3690`（逐字）：

```js
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "agent-teams-activity",
				order: 80,
				label: "AgentTeams activity",
				locale: AGENT_TEAMS_LOCALE_NAMESPACE
			}, Panel));
```

`Panel` 只是把 ctx 的服务转成 `ActivityPanel` 的 props（`3675-3683`）：

```js
			const Panel = ({ t, usePanelInfo }) => {
				return (0, react_jsx_runtime.jsx)(ActivityPanel, {
					conversationVisible: (usePanelInfo ?? useLegacyPanelInfo)((panel) => panel.activePanelId === null),
					sessionsList: ctx.sessions.list,
					modelDirectories: ctx.modelDirectories,
					openMember,
					t
				});
			};
```

它为什么"必须"在那个位置，代码注释写得很直白（`1896-1900`，逐字）：

```
		* The floater mounts in ui-layout's additive `shell.overlay`; it is not a
		* conversation node — the in-conversation panel was removed in favor of this
		* always-available monitor.
```

配套的还有会话内卡片（只做"轻量摘要 + 恢复入口"）挂在 `conversation.chat.node`（`3696-3701`），以及一个占位命令视图 `conversation.chat.commandview`（`3691-3694`）。

### 1.2 依赖的服务

`3647-3654`（逐字）：

```js
		const inject = [
			"uiConversation",
			"slots",
			"sessions",
			"locale",
			"modelDirectories",
			"layout"
		];
```

`package.json` 的 `dsh.client.inject` 与之呼应（`@deepseek-ai/dsh-client-ui-layout`、`ui-conversation`、`ui-session`、`ui-chat`、`api-session-controller`、`locale`、`ui-model-selection`）——**没有** `ui-dockkit`、**没有** `ui-sidebar-right`。这就是"手搓而非复用布局套件"的书面证据。

### 1.3 两个**非契约**的 DOM 依赖（本文档最需要记住的一点）

`2745-2757`（逐字）：

```js
			(0, react.useLayoutEffect)(() => {
				const overlay = document.querySelector("[data-shell-overlay]");
				if (overlay === null) return;
				const conversation = document.querySelector("[data-phase='active']");
				let frame = null;
				const measure = () => {
					frame = null;
					const overlayRect = overlay.getBoundingClientRect();
					const conversationRect = conversation?.getBoundingClientRect();
```

- `[data-shell-overlay]` 是 DSH 的 `AppFrame` 真实写死的属性（asar ≈`24263438`：`className: AppFrame_module_css_default.overlayLayer, "data-shell-overlay": true`）→ **存在，但不是"公共契约"**（没有任何 asar 注释承诺它稳定）。
- `[data-phase='active']` 是会话根的相位属性，面板的并列宽度与 CSS 挤位都打在它上面。
- 并列的"会话让位"也在同一条线上：`2790-2808` 给 `document.documentElement` 挂属性/变量，CSS（`563`，插件自己插入的 `<style>`，见 `566-570`）接力：

```css
html{--agent-teams-panel-shift:420px}
html[data-agent-teams-panel-open] [data-phase=active]{box-sizing:border-box;padding-right:var(--agent-teams-panel-shift)}
@media (width<=960px){html[data-agent-teams-panel-open] [data-phase=active]{padding-right:0}}
```

`2790-2798` 同时说明：这个变量被 `root.style.setProperty(PANEL_SHIFT_PROPERTY, `${geometry.width + PANEL_CONVERSATION_GAP + 18}px`)` 按真实面板宽覆盖（常量 `PANEL_CONVERSATION_GAP = 14`，`1915`），且**只在 `docked && !compact` 时挂**，卸载时移除。

---

## 2. 三种形态的实现

### 2.1 判据：`expanded` 与 `mode`

`2735`（逐字）：

```js
			const expanded = conversationVisible && activityPanelExpandedForSession(open, openOwner, current);
```

`activityPanelExpandedForSession`（`47-57`，逐字）：

```js
		/**
		* Whether an expanded activity panel still belongs to the current session.
		*
		* The panel is mounted in the root-scoped shell overlay, so React does not
		* remount it when the conversation route changes. Ownership keeps an expanded
		* panel from leaking onto the new-session screen (or another conversation)
		* while its local open state is being reset.
		*/
		function activityPanelExpandedForSession(open, owner, current) {
			return open && owner !== void 0 && owner === current;
		}
```

渲染分支 `3010-3018`（逐字，注意 `aside` 与角标是**互斥**的同一级）：

```js
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [!expanded && (0, react_jsx_runtime.jsx)(CollapsedBadge, {
				count: visibleCount,
				busy,
				t,
				onClick: () => {
					if (current === void 0) return;
					setOpenOwner(current);
					setOpen(true);
				}
			}), expanded && (0, react_jsx_runtime.jsxs)("aside", {
				ref: panelRef,
				className: ActivityPanel_module_css_default.panel,
```

`3009` 还有一条"什么都不画"的守卫：`if (!conversationVisible || !hasTeams && !expanded) return null;`
（→ 没有团队时连角标都不画；`conversationVisible` 来自 `usePanelInfo` 的 `activePanelId === null`，即"用户正看着会话"。）

### 2.2 并列（docked）

默认值就是 docked（`1733-1740`，逐字）：

```js
		const DEFAULT_PANEL_LAYOUT = Object.freeze({
			mode: "docked",
			x: 0,
			y: 64,
			width: 388,
			height: 640,
			heightMode: "auto"
		});
```

落位是"锚会话区右缘 - 18 - width、y 固定 64、高度吃满到 48px 留白"（`1796-1809`，逐字）：坐标准则从**会话矩形**算，不是从窗口：

```js
			if (layout.mode === "docked") {
				const y = clamp(64, 12, Math.max(12, boundsHeight - minimumHeight - 12));
				const availableHeight = Math.max(1, boundsHeight - y - 48);
				const height = clamp(availableHeight, Math.min(minimumHeight, availableHeight), maximumHeight);
				const anchorRight = clamp(bounds.anchorRight, 0, boundsWidth);
				const maximumX = Math.max(12, boundsWidth - width - 12);
```

`bounds.anchorRight` 由 `2756` 算出：`Math.min(Math.max(conversationRect.right - overlayRect.left, 0), overlayRect.width)`。

**并列 ≠ 布局列**：会话区不是被布局挤窄，而是被**加内边距**（§1.3 的 CSS）。窄视口（≤960px）直接放弃挤位，并把面板降级成"贴满的插屏"（`1768-1790`，逐字）：

```js
		/** Whether the panel should become a simple inset overlay with no gestures. */
		function compactPanelForBounds(bounds) {
			return bounds.width <= 960;
		}
```

```js
			if (compactPanelForBounds(bounds)) return {
				...layout,
				x: 12,
				y: 12,
				width: Math.max(1, boundsWidth - 24),
				height: Math.max(1, boundsHeight - 24)
			};
```

`compact` 还会连带关掉手势与形态按钮（`beginMove`/`beginResize` 里的 `if (compact …) return`，`2933`、`2946`；`3047` 的 `!compact &&` 只包住 dock 按钮；CSS 里 `.aYQbCq_panel[data-compact] .aYQbCq_panelHead{cursor:default;touch-action:auto}` 同在 `563` 那一行）。

### 2.3 悬浮（floating）——同一个 `aside`，只换 `mode` 与几何

切换动作只有一个（`2998-3001`，逐字）：

```js
			const toggleDock = (0, react.useCallback)(() => {
				const liveGeometry = panelGeometryForGesture();
				commitLayout(liveGeometry.mode === "docked" ? floatPanelLayout(liveGeometry, boundsRef.current) : dockPanelLayout(liveGeometry, boundsRef.current));
			}, [commitLayout, panelGeometryForGesture]);
```

`floatPanelLayout` / `dockPanelLayout` 的注释把"无跳跃"讲清楚了（`1821-1835`，逐字）：

```js
		/** Undock without a visual jump by adopting the panel's resolved rectangle. */
		function floatPanelLayout(geometry, bounds) { … }
		/** Return to the right dock, preserving width and restoring content-fit height. */
		function dockPanelLayout(layout, bounds) { … mode: "docked", heightMode: "auto" … }
```

- 位置：`panelStyle.transform = translate3d(x, y, 0)`（`3003-3008`）。
- 拖动：头部 `onPointerDown: beginMove`（`3033`），`beginMove` 里 `setPointerCapture` + 4px 阈值（`MOVE_THRESHOLD = 4`，`1916`；`2972`），并显式忽略落在按钮上的按下（`2933`：`event.target.closest("button") !== null` 直接返回）。
- 缩放：左侧 / 底边 / 右下角三根手柄（`3109-3140`），手柄按 `geometry.mode === "floating"` 或"docked 只允许左边"决定是否渲染/生效（`2946`）。
- 手势写回几何是 **rAF 合帧** 的（`2911-2928` 的 `flushScheduledLayout` / `scheduleLayout`）。
- 拖动/缩放的 CSS 只改阴影与 `user-select`（`563`：`.aYQbCq_panel[data-dragging],.aYQbCq_panel[data-resizing]{user-select:none;box-shadow:…}`），面板上的 `data-dragging` / `data-resizing` 由 React 状态给出（`3027-3028`）。

### 2.4 收缩为悬浮按钮

**谁渲染**：面板组件自己。角标组件（`2026-2044`，逐字）——

```js
		/** Collapsed badge: an always-visible corner pill while any team exists. */
		function CollapsedBadge({ count, busy, onClick, t }) {
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: ActivityPanel_module_css_default.badge,
				"data-agent-teams-collapsed": true,
				"data-busy": busy,
				onClick,
				"aria-label": t("activity.badgeAria", { count }),
				children: [ … badgeDot "data-busy": busy … , … badgeCount … count ]
			});
		}
```

**长在哪**：CSS 给它固定角位（`563`，逐字片段）：

```css
.aYQbCq_badge{…position:absolute;top:64px;right:18px}
@media (width<=640px){.aYQbCq_badge{top:56px;right:10px} …}
```

**点击后如何恢复**：`setOpenOwner(current); setOpen(true)`（`3014-3018`）→ `expanded` 变真 → 同一个 `aside` 以**持久化的 mode**（默认 docked）出现。

**第二条恢复路（旧会话回看）**：会话内卡片派发窗口事件——

`467-479`（逐字）：

```js
		/** Window event name the floater listens for to open itself. */
		const OPEN_PANEL_EVENT = "agent-teams:open-panel";
```

```js
		function openActivityPanel(data) {
			window.dispatchEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: { … } }));
		}
```

面板侧监听（`2825-2849`）：`setOpenOwner(activeSession); setOpen(true);`，并可携带 `teamId` 把"已归档的团队摘要"塞进 `historic`。

**自动展开 / 自动收起**（这是 agent-teams 独有的产品判断，不是形态机制本身）：

- 常量：`AUTOCLOSE_GRACE_MS = 2e3`（`1904`）、`AUTO_OPEN_SETTLE_MS = 4e3`（`1910`）。
- 判定（`58-65`，逐字）：

```js
		/**
		* Auto-expand only for live teams that appear after the current session's
		* initial restore pass. Replayed cards, archived teams, and live teams restored
		* while reopening a conversation must remain behind the collapsed badge.
		*/
		function activityPanelShouldAutoExpand({ alreadyAutoOpened, pageSettled, restoreComplete, previousLiveTeamIds, currentLiveTeamIds }) {
			return !alreadyAutoOpened && pageSettled && restoreComplete && currentLiveTeamIds.some((teamId) => !previousLiveTeamIds.has(teamId));
		}
```

- 执行（`2864-2900`）：满足就 `setOpenOwner/ setOpen/ setAutoOpened`；团队归零后 `after 2s` 收起并复位。
- 打开态的**所有权**：换会话时把 `open` 复位（`2777-2789`），换会话界面（非会话面板）由 `conversationVisible` 直接压掉（`2735`）。

### 2.5 状态存在哪

| 状态 | 放在哪 | 证据 |
|---|---|---|
| `open` / `openOwner` / `autoOpened` / `wasActive` / `historic` | **React 内存 state** | `2701-2706` |
| `layout`（mode/x/y/width/height/heightMode） | React state + **localStorage**（`dsh-agent-teams:activity-panel:v1`） | `2706`、`1732`、`2741-2743` |
| 读取入口 | `initialPanelLayout()` → `parsePanelLayout(localStorage.getItem(KEY))` | `1918-1921` |
| 解码策略 | 版本化 key + **严格拒绝半坏状态**（mode 必须是 `docked`/`floating`，四个数必须是有限数，否则整体回默认） | `1747-1766` |
| `bounds`（overlay/会话矩形） | React state，由 ResizeObserver + window resize 重测 | `2749-2775` |
| 团队/任务数据 | **不在客户端**：轮询宿主 `/plugins/dsh-agent-teams/state` 的服务器快照（磁盘真相 + 实时子 Agent 活动） | `291`、`282/289`、`2809-2824`；注释 `1893-1896`；宿主注册 `lib/index.js:162-183` |

**关键推论（证据强，但未实测）**：刷新页面后 `open` 一定是 `false`（没有持久化），而 `layout.mode` 会被恢复 → **刷新后永远先看到角标，点开时保留上次的 docked/floating 形态与位置**。

### 2.6 它依赖的 DSH 公共原语（逐条 + 证据）

| 原语 | 用法 | 证据 | 是不是公共契约 |
|---|---|---|---|
| 槽位 `shell.overlay` | 面板唯一落点 | `3684-3690`；DSH 侧 `list`+`root`（`design.zh-CN.md:141`） | ✅ 是 |
| 槽位 `conversation.chat.node` | 会话内卡片 | `3696-3701` | ✅ 是 |
| `ctx.sessions.list` | 当前会话、`subscribe/getSnapshot` | `2714` | ✅ 是 |
| `ctx.modelDirectories` | 模型选择器数据 | `3679` | ✅ 是 |
| `ctx.layout.selectPanel(null)` | 点成员时回到会话 | `3630`、`3641` | ✅ 是（但不参与形态） |
| `ctx.locale` | 文案 | `3666-3669` | ✅ 是 |
| `usePanelInfo().activePanelId` | "会话界面是否在前" | `3677` | ✅ 是 |
| DOM `[data-shell-overlay]` | 量 overlay 矩形 | `2745` | ⚠️ **实现细节**（DSH 会改） |
| DOM `[data-phase='active']` | 量会话矩形 + CSS 挤位锚点 | `2747`、`563` | ⚠️ **实现细节** |
| 自注入 `<style>` | 面板/角标全部样式 | `566-570`、`435-439` | ✅ 插件自己的 |
| Pointer Events + `setPointerCapture` | 拖拽/缩放 | `2935`、`2949` | ✅ 浏览器 API |
| `window.localStorage` | 只有几何 | `1920`、`2742` | ✅ 浏览器 API |
| `window.dispatchEvent(CustomEvent)` | 卡片→面板的第二恢复路 | `473` | ✅ |
| **未用**：`uiWorkspace` / `inputActions` / `rightbar` / `ctx.layout.openRightbar` / `ui-dockkit` | —— | `3647-3654`、`package.json dsh.client.inject` | —— |

---

## 3. DSH 自己那一套（原生并列/悬浮/折叠）—— 与 agent-teams 完全不同

这一节不是"顺带一提"：它决定了小程序应该"抄 agent-teams"还是"用 DSH 的座位"。文本证据来自 asar 内嵌的包 README 与源码（字节偏移为复核入口）。

### 3.1 真实存在的右列座位

`@deepseek-ai/dsh-client-ui-sidebar-right`（asar ≈`32568016` 提供 `ctx.sidebarRight`）注册的座位树（asar ≈`32568800`，逐字）：

```js
				const disposeSeat = ctx.slots.inject("rightbar", function* () {
					yield ctx.slots.register({
						name: "rightbar",
						children: { "rightbar.session": {
							kind: "single",
							scope: "session"
						} }
					}, RightbarRoot);
					yield ctx.slots.register({
						name: "rightbar.session",
						locale: NS,
						children: {
							"sidebar.right.pane.tab": {
								kind: "keyed",
								scope: "session",
								inject: { hooks: { tabInfo: tabInfoFactory } }
							},
							"sidebar.right.pane.tab.title": { … },
							"sidebar.right.tab.menu.item": {
								kind: "list",
								scope: "session"
							}
						},
```

而"一列到底是什么"由 `AppFrame` 画（asar ≈`24263438`，逐字）：

```js
					(0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CenterColumn, { children: main }), (0, react_jsx_runtime.jsx)(RightbarColumn, { children: renderSlot("rightbar", {
						width: normal.rightbar,
						viewportWidth: viewport,
						canShow: normal.rightbar > 0
					}) })] }),
```

对照：**`details` 这个座位名在 asar 里 0 命中**（`name: "details"` = 0；`name: "rightbar"` = 1；`name: "rightbar.session"` = 1）——与 dsh-miniapp 自己的审计结论一致（`docs/design.zh-CN.md:146,156`）。

### 3.2 两种呈现形态（DSH 原生术语）

asar ≈`32416800`（`ui-sidebar-right/README.zh.md`，逐字）：

```
| 形态 | 轨道 | 面板 |
|---|---|---|
| `push`（默认） | 面板宽度：会话区让出空间 | 在轨道内；它的左缘与会话区的右缘沿框架自己的曲线一起移动 |
| `fullscreen` | 保留宽屏普通轨道；窄屏自动全屏不占轨道 | 覆盖整个窗口 |

席位通过 `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()` 报告呈现，框架不注入本包。
```

注意：`openRightbar` 的语义是"**报告呈现**"，不是"把列打开"（asar ≈`24268818` 的 `layout` 服务实现逐字：`/** Report the right panel's track and fullscreen presentation. */ openRightbar(track, fullscreen) { this.panels.openRightbar(track, fullscreen); }`）。

### 3.3 收缩：DSH 原生的"展开按钮"

同一份 README（asar ≈`32416800`，逐字）：

```
面板没有标题行。它的两个控件——形态切换与折叠按钮——搭在套件 chrome 席位上，位于右上格 tab 条的最末端，
因此 tab 条就是面板的整条上边。…
## 展开按钮
面板隐藏时，会话 header 角落席位里的一个按钮（`conversation.session.header.corner`，在工具组右缘之外，
与 Session 日志控件齐平）是回去的路。它的图形是左侧 sidebar 折叠图标的镜像。
```

### 3.4 插件能拿到的动作：`ctx.sidebarRight`

同一份 README（asar ≈`32422000`，逐字摘录）：

```
`close(tabId)` 关闭一个 tab；`active()` 读取活动 tab。`isExpanded()` 与 `toggleExpanded()` 读取并驱动该列的展开；
形态切换是面板自己的控件，不属于这个接口。布局操作供以编程方式安排该列的调用方使用…：
`focus(tabId)` 聚焦一个 tab 及其格；`split(paneId?)` … 分栏一个停靠格…；
`float(tabId, rect?)` 把停靠 tab 浮出为浮窗；`dock(paneId)` 把浮窗放回活跃停靠格。
```

扩展席位（同一份 README，逐字）：类型 `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide? })`；正文 `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`；另有 `sidebar.right.tab.guide`（chain）与 `sidebar.right.tab.menu.item`（list）。并明确：**"目前没有面向格级动作或折叠态控件的席位，因为还没有东西需要它"**。

已知限制（同一份 README，逐字）：**"只在内存中。不持久化任何东西；刷新让每个会话从折叠态开始。"**、"没有会话就没有停靠面"、"硬编码的层叠"。

### 3.5 浮窗/分栏的"精算"在哪

同一份 README（asar ≈`32415722` 一带，逐字）：

```
布局本身——分裂树、它的操作、拖拽手势、浮窗——属于 `@deepseek-ai/dsh-client-ui-dockkit`，并保持与宿主无关。
本包提供套件拒绝知道的一切：产品文案、tab 的 `kind` 是什么意思、新格用哪个 tab 播种、停靠面挂在哪里、其它插件如何触达它。
```

代码侧佐证：`floatTab` / `unfloatPane` / `moveFloat` 这些动作在 `sidebar-right` 的 store 里实现，而算法来自 `ui-dockkit` 的纯规划器（asar ≈`32457000`，逐字）：

```js
					floatTab: (d, sessionId, tabId, rect) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state, mint) => (0, _deepseek_ai_dsh_client_ui_dockkit.planFloatTab)(state, mint, tabId, rect).ops, seed));
					},
```

**⇒ dockkit 没有面向插件的服务**（asar 里 `provide("dock` / `ctx.dockkit` / `"dockkit":` 均 0 命中）；插件能触达的只有 `ctx.sidebarRight`。

---

## 4. dsh-miniapp 现状（逐面对照）

### 4.1 它现在有五个"跑的地方"

`LAYOUT_PLACES`（`lib/client.js:790-796`，逐字）：

```js
		var LAYOUT_PLACES = [
			{ key: "panel", icon: "panel", labelKey: "layout.place.panel" },
			{ key: "drawer", icon: "side", labelKey: "layout.place.drawer" },
			{ key: "session", icon: "tab", labelKey: "layout.place.session" },
			{ key: "corner", icon: "corner", labelKey: "layout.place.corner" },
			{ key: "browser", icon: "browser", labelKey: "layout.place.browser" }
		];
```

三个是**互斥浮层**，靠一个开关数组判决（`775` + `827-878`，逐字）：

```js
		var SURFACE_KEYS = ["open", "drawer", "corner"];
```

```js
					for (var index = 0; index < SURFACE_KEYS.length; index += 1) {
						var opened = SURFACE_KEYS[index];
						if (patch[opened] !== true) continue;
						for (var other = 0; other < SURFACE_KEYS.length; other += 1) {
							if (SURFACE_KEYS[other] !== opened) next[SURFACE_KEYS[other]] = false;
						}
					}
```

组件复用是**已经做过的**，只是切成两档而不是"一个 mode"：`MiniAppFloatingRunner`（`≈3600`，逐字）：

```js
		function MiniAppFloatingRunner(props) {
			var t = props.t;
			var variant = props.variant === "corner" ? "corner" : "column";
```

| 面（`LAYOUT_PLACES`） | 实现 | 座位/接口 | 状态键 |
|---|---|---|---|
| `panel` 全屏浮层 | `MiniAppOverlay`（`≈2866`）经 `MiniAppOverlaySeat`（`≈4076`）渲染 | 槽位 `shell.overlay` | `ui.open` / `ui.runningId` |
| `drawer` 右侧栏列 | `MiniAppRightPanel`（`≈4066`）→ `MiniAppFloatingRunner variant="column"` | **槽位 `details`**（`RIGHT_PANEL_SLOT`，`≈102`）+ `layout.openDetails()` | `ui.drawer` / `ui.drawerId` |
| `corner` 右上浮窗 | `MiniAppFloatingRunner variant="corner"` | 同一个 `shell.overlay` 座位里画 | `ui.corner` / `ui.cornerId` / `ui.cornerPosition` / `ui.cornerSize` |
| `session` 会话页签 | `MiniAppSessionView`（`≈2524`） | 槽位 `conversation.view`（**按需**登记） | 会话分片 |
| `browser` 浏览器新页签 | `openInBrowser` | `window.open` | 无 |

切换的唯一入口 `switchLayout`（`1521-1556`）：`panel/drawer/corner` 各写自己的键 + id（互斥由 `set` 顺手做）；`browser` 不动任何浮层；`session` 先关三个浮层再去 DSH 页签。

### 4.2 差距清单（对照第 2、3 节）

| # | agent-teams / DSH 原生 | dsh-miniapp 现状 | 差距性质 |
|---|---|---|---|
| G1 | 一个 `mode`（docked/floating）+ 一个 `collapsed` | 三个**独立开关** + 三个渲染分支 | **模型差距**：没有"同一实例换形态"，只有"关一个开另一个" |
| G2 | `CollapsedBadge` 常驻角标，点击恢复 | **没有任何收缩态**：`corner` 的 ✕ = 销毁（`MiniAppOverlaySeat` 里 `onClose: function () { ui.set({ corner: false }); }`，`≈4106`）；`panel`/`drawer` 同理 | **缺失形态**（用户这次要的正是它） |
| G3 | 几何进 localStorage（版本化 key、严格解码） | `cornerPosition`/`cornerSize` 只在模块内存（`createUiState` 里那对键的注释，`≈848-855`，明说是"用户自己摆过"的临时状态）；**刷新即回默认角位** | 持久化差距（agent-teams 也只存几何，不存开合） |
| G4 | agent-teams 并列 = CSS `padding-right`；DSH 原生 = `rightbar` 轨道（`push`） | `drawer` 走 `details` + `layout.openDetails()` | **当前是坏的**：`details` 幽灵名（`design.zh-CN.md:146`）、`openDetails` 不存在（`:156`）；我复核 asar：`name: "details"` = 0 命中，`rightbar`/`rightbar.session` 有声明。仓库自己的判词更直白（`test/seat-contract.test.mjs:78-82`，逐字）：**"`details`：0.1.5 的右列是 `rightbar` / `rightbar.session`（single + root / single + session），由 `ctx.layout.openRightbar(track, fullscreen)` 驱动。`details` 这个名字不存在，所以「切换布局 → 右侧栏」那条路从来没生效过。"** |
| G5 | 面板在两形态间**不重挂**（同一 DOM，`transform` 变） | 三个面是三个组件实例（`MiniAppOverlay` / `MiniAppFloatingRunner(column)` / `(corner)`），切过去必然卸载重建 iframe | 一致性差距：同一小程序切面 = 重新加载（`RunnerView` 的 iframe 也会重挂） |
| G6 | 面板 1s 轮询宿主状态 | 目录走 `appCatalog` + HTTP，无轮询需求 | 不构成差距（数据源不同） |
| G7 | 收缩按钮/展开按钮有**公共座位**（`conversation.session.header.corner`）或常驻角位（自绘 `position:absolute`） | 现成入口：`sidebar.footer.action`（侧栏）、`conversation.session.header.utilities`（工具栏）；但都是"去库页面"，不是"把正在跑的小程序收起来" | 设计选择：收缩态按钮挂哪，有两条**已被 DSH 自己用过的**路 |
| G8 | 没有"格级动作/折叠态控件"的席位，只能自绘 | 同上 | 与 G2/G7 同源 |

### 4.3 顺带发现的两处**代码与注释漂移**（写文档时顺手记下，不在本任务范围）

1. `lib/client.js:3159-3176`（"两个贴边浮层"那一节）写的是"抽屉锚在**整个窗口**的右边，通高"、"**为什么是浮层而不是布局列**…所以这里**不碰** `details`"；但同一文件的 `openRightPanel/closeRightPanel`（`≈1379-1408`）+ `registerRightPanel`（`≈6649`，`ctx.slots.inject(RIGHT_PANEL_SLOT …)`）实现的是**接管 `details` 真列 + `layout.openDetails()`**，`RunnerView` 的 `variant="column"` 也说明它由布局给宽高（`MiniAppFloatingRunner` 内的几何注释：定位只对 `corner` 有意义）。→ **注释描述的是上一代实现**，与当前代码相反。建议后续以一句"注释待更正"记在待办里（本任务只读，不动）。
2. `lib/client.js:2169` 与 `:2249` 说"四个运行面（共用 `RunnerView`）"，而 `LAYOUT_PLACES` 是**五个**（第 5 个 `browser` 在 DSH 之外，不共用 `RunnerView`）。→ 术语上"四个运行面"= 面板/右侧栏/会话页签/右上浮窗，**建议在文档里显式写死这个定义**，否则"四运行面一致"会被误读成"五个都要一致"。

---

## 5. 映射表：agent-teams 的概念 → 小程序的落点

| agent-teams | DSH 原生等价物 | 小程序里最接近的现状 | 可复用 | 要新写的 |
|---|---|---|---|---|
| `shell.overlay` 里的单一面板 | 同 | `MiniAppOverlaySeat`（已在 `shell.overlay`） | ✅ 座位已占 | 把三个分支收进一个组件 |
| `layout.mode`（docked/floating） | `push`/`fullscreen`（`ctx.layout.openRightbar`） | `ui.drawer` 与 `ui.corner` 两个布尔 | ✅ `MiniAppFloatingRunner` 已有 `variant` | 一个 `mode` 字段 + 互斥判决改写 |
| `commitLayout` + localStorage 几何 | DSH 布局自己管右列宽（asar ≈`24264000`："keeps that px preference across resizes and close" —— **是否跨刷新未核**） | `cornerPosition/cornerSize`（内存） | ✅ 定位/夹取/复位纯函数（`cornerResizeTo`、`cornerClampSize`） | 版本化 key + 严格解码 + 只存几何 |
| `CollapsedBadge` | `conversation.session.header.corner` 展开按钮；或自绘常驻角标 | **无** | ✅ `MiniAppBar` 的"单颗按钮 + 下拉"已经是入口的写法 | 收缩态组件 + 恢复路径 |
| 按钮上的 dock/collapse 两枚图标 | tab 条末端的形态切换 + 折叠 | 头部那排「切换布局」（5 枚） | ✅ `layoutSwitcherWidth()` 那套算账 | 语义从"切到别处"改为"换形态" |
| 会话内卡片 + `agent-teams:open-panel` 事件 | 无 | 「继续迭代」等入口在库/运行页 | ✅ 现成的 `AgentTeamsCard` 模式（`conversation.chat.node`） | 可选：卡片里加"唤回面板" |
| 1s 轮询宿主快照 | —— | 目录 SWR/HTTP | ✅ | 不需要 |

---

## 6. 三个可行设计方案

> 三个方案都**复用 `RunnerView`**（这是既有事实：`MiniAppOverlay`、`MiniAppFloatingRunner` 的身体是同一个 `RunnerView`，`chrome` 决定画哪条工具栏，注释在 `RunnerView` 定义上方那段 `props.chrome` 说明里）。差别在"模式状态归属"、"收缩按钮挂哪"、"并列走哪条路"。
> 每个方案都按"四运行面一致"验收：**四个运行面 = 面板 / 右侧栏 / 会话页签 / 右上浮窗**（浏览器新页签在 DSH 之外，不在此列，见 §4.3-2）。

### 方案 A —— 照抄 agent-teams：一个 `mode` + 一个角标，并列用 CSS 挤位

- **状态归属**：`createUiState` 里把 `open/drawer/corner` 三个布尔换成 `surfaceMode: "hidden" | "docked" | "floating"`（会话无关的全局，沿用现有模块级 store）+ 现有的 `drawerId/cornerId` 合并成一个 `appId`。
- **渲染**：`shell.overlay` 那一个座位里画三选一：`hidden + 有 appId` → 角标；`docked` → 面板（沿用 `MiniAppFloatingRunner`，另开一个 `variant="docked"`，用 CSS 给 `[data-phase=active]` 挤位）；`floating` → 现有 `variant="corner"`。
- **收缩按钮挂哪**：自绘常驻角标（`position: fixed; top/right`，与 agent-teams 同构，`data-dsh-miniapp-collapsed` 做测试抓手）。
- **并列怎么实现**：照 agent-teams，自注入 CSS + 给 `documentElement` 挂属性/变量。**代价**：依赖 DSH 私有的 `[data-phase=active]`（非契约）。
- **代价/风险**：① 与 agent-teams 同款 DOM 依赖（DSH 换相位属性就断）；② 挤位与 DSH 自己的右列（若用户同时开工具详情/右栏）会叠加 padding → 需要像 agent-teams 那样读 `usePanelInfo`/`layout` 判断"当前是不是会话界面"；③ 要新写拖拽后的夹取（可复用现有纯函数）。

### 方案 B —— 并列走 DSH 原生 `rightbar`，悬浮与收缩自绘（推荐先评估这条）

- **状态归属**：`mode` 仍在 `createUiState`（`docked` 的展开/折叠由 `ctx.sidebarRight.isExpanded()/toggleExpanded()` 承载，**不要**自己再存一份）。
- **并列怎么实现**：把"小程序"做成右栏里的**一个 tab 类型**——`ctx.sidebarRightTabs.register({ id: 'dsh-miniapp', kind: 'miniapp', … })` + 正文注册到 `sidebar.right.pane.tab`（key=same id），用 `ctx.sidebarRight.openTab('miniapp', …)` 打开。轨道、拖宽、窄屏自动全屏、**折叠按钮与展开按钮**全部由 DSH 提供（`push` 形态 = 会话区让位 = 用户说的"并列"）。
- **收缩按钮挂哪**：DSH 折叠后**自动**在 `conversation.session.header.corner` 出现展开按钮（DSH 自己的）；小程序不需要自绘角标 —— 但若想保留"角标显示当前在跑哪个小程序"，仍可在 `shell.overlay` 自绘一枚（不与 DSH 抢座位）。
- **悬浮怎么实现**：`ctx.sidebarRight.float(tabId, rect?)` 把停靠 tab 浮出为浮窗、`dock(paneId)` 放回 —— **由 dockkit 精算**，小程序不写拖拽/夹取/持久化。
- **四运行面一致**：面板/会话页签/右上浮窗继续走 `RunnerView`；并列那一面变成"右栏 tab 里的同一个 `RunnerView`"，四处的 `chrome` 语义（`full`/`compact`/`none`）需要新增一档或复用 `none`。
- **代价/风险**：① 依赖 `ctx.sidebarRight`（0.1.5-rc.1 的公开服务，asar 有 `provide("sidebarRight")`；但它是**别的产品的列**，语义会随之演进）；② `sidebar.right.pane.tab` 是 `keyed`、`rightbar.session` 是 `single` —— 我们的 tab **不能**顶掉 DSH 自己的 Files/预览 tab，必须走 keyed 的加法路径（这一点是它的设计意图，见 README 的扩展席位一节）；③ 与现有"库页面浮层"产品形态的关系需要产品决策：库是浮层，运行面之一是右栏 tab。

### 方案 C —— 最小改动：保留座位与组件，只引入 `mode` + 收缩态

- **状态归属**：`createUiState` 新增 `collapsed: boolean` 与 `mode: "docked" | "floating"`；**不删** `open/drawer/corner` 三个键，而是把它们降级为"哪一面在画"的派生物（迁移期两套并存，测试钉住映射）。
- **渲染**：`MiniAppFloatingRunner` 的 `variant`（现在只有 `corner` / `column` 两档）**保持不动**，只把"谁来决定用哪一档"从三个布尔改成 `mode`；另加一个 `MiniAppCollapsedBadge` 挂在 `shell.overlay` 座位里（与 `MiniAppOverlaySeat` 同级）；`switchLayout` 的 `panel/drawer/corner` 三个去处改为"设置 `mode` + 打开"。
- **收缩按钮挂哪**：自绘角标（同方案 A 的角标），**位置沿用现有 `cornerClampSize`/默认角位**的算法，不引入新的几何坐标系统。
- **并列**：**先不动** `details`（它现在是坏的），把"并列"定义为"`variant="column"` 的右列"，等 G4 修好（换成 `rightbar`/`openRightbar` 或按需保留自绘）后再接。
- **四运行面一致**：面板/会话页签/右上浮窗不动 → 天然一致；收缩态是**新增的第五种呈现**，它不跑 iframe（只是按钮），所以不破坏"一份 iframe 实现"。
- **代价/风险**：① 只解决"收缩态"，没解决"并列 ⇄ 悬浮原地切换"（G1/G5 仍在）；② 两组状态并存期容易漂移（必须有测试钉映射）；③ 用户要的"参考 agent-teams"在模型上只落实了一半。

### 三个方案的横向对比

| 维度 | A（照抄 agent-teams） | B（DSH 原生 rightbar + sidebarRight） | C（最小改动） |
|---|---|---|---|
| 复用 `RunnerView` | ✅ | ✅ | ✅ |
| 并列的物理实现 | 自绘面板 + CSS padding 挤会话列 | DSH `rightbar` 轨道（`push`） | 沿用现有 column（**当前打不开**） |
| 悬浮的实现 | 自绘（现有 corner 那套） | `ctx.sidebarRight.float()`（dockkit 精算） | 自绘（现有 corner 那套） |
| 收缩按钮 | 自绘常驻角标 | DSH 自动给展开按钮（可另加角标） | 自绘常驻角标 |
| 原地切换形态 | ✅（同一 DOM 换 mode） | ✅（float/dock 是同一 tab） | ❌（仍是三选一重建） |
| 非契约 DOM 依赖 | 高（`[data-phase=active]`） | 低（走服务） | 中（沿用现有） |
| 几何持久化 | 新写（可抄 agent-teams 的版本化栈） | DSH 自己管（右列宽/浮窗） | 新写（若要做） |
| 工作量 | 中（约等于把 agent-teams 那 600 行的核心搬一遍） | 中（但风险在别人的契约上） | 小 |
| 主要风险 | DSH 改相位属性 → 挤位断 | `sidebarRight` 语义演进；产品上"库在浮层、运行在右栏" | 只解决一半需求 |

**未做的判断（留给队长/产品）**：用户说的"参考 agent-teams"到底是要**它的形态模型**（docked/floating/collapsed 三态一套状态机），还是要**它的自绘方式**。若只要前者，**方案 B 更省且更稳**（DSH 已经把三态都实现了，agent-teams 只是没用）；若还要求"面板长在会话右上角、由我们自己画"，则是方案 A。

---

## 7. 证据档位（结论各自站得住几分）

**代码/文档证据（可直接复核）**

- agent-teams 全部结论来自源码直读：`lib/client.js` 的 1732/1748-1766/1796-1809/1918-1921/2026-2044/2701-2708/2735/2790-2808/2825-2849/2864-2900/2911-3008/3010-3018/3109-3140/3647-3690 与 `563` 的 CSS 文本、`lib/index.js:162-183`、`package.json` 的 `dsh.client.inject`。
- DSH 原生那一套来自 asar 内嵌的 `ui-sidebar-right/README.zh.md`（asar ≈`32416800`–`32426000`）与源码（≈`32567600`、`32568800`、`24263438`、`24268818`、`32457000`），以及 `layout` 服务文档（≈`34046220`）。
- dsh-miniapp 现状来自源码直读 + 仓库自己的审计（`docs/design.zh-CN.md:141,146,156,190`）以及 `test/seat-contract.test.mjs:53,78-87`。

**推断（明确未验证，请勿当事实用）**

1. **刷新后必然回到角标态**：由"`open` 是 React state（`2701`）+ 只有 `layout` 落 localStorage（`2741-2743`）"推出；**未实测**（本会话没有 `cua-driver`，无法观察 GUI）。
2. **并列挤位在窄屏/别的插件也用 `[data-phase=active]` padding 时会打架**：由 CSS 只加不减（`padding-right` 直接赋值，无 `!important` 竞争分析）推出；**未实测**。
3. **`ctx.sidebarRight.float()` 对第三方 tab 类型有效**：README 说"浮窗不受整栏收起影响"、"`float(tabId, rect?)` 把停靠 tab 浮出为浮窗"，但**没有第三方插件这么用的先例可查**（`ui-sidebar-documentpreview` 是唯一的活样例，需另行核对它是否用了 float）→ **方案 B 的可行性需要一次真机验证**。
4. **`sidebar.right.pane.tab` 的 keyed 加法不会顶掉 DSH 自带的 Files/预览 tab**：由 `kind: "keyed"`（asar ≈`32568800`）与 `test/seat-contract` 的同型判断推出；**未实测**。
5. **agent-teams 的 docked 面板与 DSH 右栏同时打开时的相互影响**：代码里没有互斥逻辑（它只用 `usePanelInfo().activePanelId` 判断"会话界面是否在前"）→ **推断会并排挤两次宽度**，未实测。

**未取证（明说"未找到"）**

- agent-teams 有没有用过 `rightbar`/`openRightbar`：**没找到**（`grep rightbar` 在 `lib/client.js` 只命中一句无关文案 `dependency.hint.parallel`）。
- `sheet/float` 之外的持久化：**没有**（除 `PANEL_LAYOUT_STORAGE_KEY` 外无第二处 `localStorage` 写入）。
- DSH 的 `sidebar.right.pane.tab` 正文里能不能挂 iframe：**未找到禁止性说明**，但也没有 iframe 先例证据（Files 是树、预览是文本）。
- `details` 在**别的** DSH 版本是否存在：只核了本机 `0.1.5-rc.1` 的 asar（0 命中），别的版本未核。

---

## 8. 给下一步的最短路径建议（不写代码，只给判据）

1. **先补一次真机观察**（本任务做不到，缺 `cua-driver`）：把一个团队跑起来，看 docked 面板是否真的把会话列挤窄、角标落在哪里、刷新后是否回到角标。这一步能验证 §7 的推断 1、2。
2. **再决定"并列"的物理实现**：如果接受"DSH 的右栏就是并列"，走方案 B；如果要求"面板必须长在会话右上角、由小程序自己画"，走方案 A（并接受 `[data-phase=active]` 依赖）。
3. **无论哪个方案，`collapsed` 都要有**：这是用户这次明确要的、也是现状**完全没有**的一态（G2）；它不跑 iframe，所以不会被"一份 iframe 实现"的约束挡住。
4. **不要顺手修 `details`**：它是既有缺口（`design.zh-CN.md:146` 显式写了"本轮不修"），与本需求的关系是"并列那一面现在打不开"，修它属于另一件事（换成 `rightbar` + `openRightbar` 或自绘）。
