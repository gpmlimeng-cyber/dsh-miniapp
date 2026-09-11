// dsh-miniapp — 客户端半边。
//
// 手写成 DSH 的 `__ModuleLoader__` 形态，因此无需任何构建步骤：宿主直接加载
// 这个文件。只依赖 `react`（`require("react")`），样式全部走主题 token 内联，
// 这样深浅色主题自动跟随、也不会与设计系统漂移。
//
// 侧栏入口：注入一个 32×32 的描边图标按钮，作为设置栏那一行（div.triggerRow）的
// **最后一个孩子** —— [设置][小程序]，右对齐是那一行的 flex 布局白送的，不靠绝对定位。
// `sidebar.settings` 是 single 槽位（replaceRisk: shadows-shipped-ui），往那里注册
// 第二行会替换掉设置按钮本身，所以只能走 DOM 注入。
// `sidebar.footer.action` 上的注册保留为兜底：注入成功时它自己让位。
//
// 七处座位（**每一个都对着已安装 asar 的真实声明核过**；审计表见
// docs/design.zh-CN.md 的「座位契约审计」）：
//   * `sidebar.footer.action`       —— 侧栏「小程序」入口（**兜底**，注入成功时不出现）；
//   * `shell.overlay`               —— **全屏浮层**（库页面与运行页）的渲染口。
//                                      2026-09 之前它同时画"右侧抽屉"与"会话右上角浮窗"
//                                      两个自绘面，那两面退役后这里只剩全屏浮层一项；
//   * `conversation.view`           —— 会话头部页签里的「小程序」一格（**会话主体**，
//                                      占满会话区；它不是浮层，也不参与互斥）；
//   * `conversation.session.header.utilities` —— 标题栏右侧那一栏（入口按钮 + ▾ 面板）；
//   * `conversation.input.left`     —— 输入工具行左侧**两格**：「小程序」模式 chip 与
//                                      「你选了什么」；`list` + `session`，空白会话也渲染；
//   * `conversation.input.dock`     —— 输入卡片**上方**一整行：模板面板（进入模式后铺开）
//                                      与「创建小程序」意图的落地座位；
//   * `details`（**幽灵名，见审计表**）—— 右侧抽屉那一格。0.1.5 里没有这个名字，
//                                      所以那条路从来没生效；未在本次修复范围内，已记账。
//
// 后两组是同一个模式的三面：点模板会把模板的描述写进输入框，用户改完直接回车。
// 状态按 sessionId 分片 —— 模式是会话的属性，不是全局开关。
//
// 2026-09 修过一次座位漂移：原来挂的 `conversation.hero.modeActions` 与
// `conversation.input.accessory` 在 0.1.5 里**根本不存在**（`ctx.slots.inject` 对未声明
// 的名字静默等待，既不注册也不报错），而 `conversation.composer.dock` 只在**非空白**
// 会话渲染 —— 与面板的用途互斥。三个座位因此全都没出现过。
// 现在有一条可自动跑的「座位契约检查」（test/seat-contract.test.mjs）盯着这些名字，
// 同一个失效模式不会再无声无息地发生第三次。
//
// 于是「同一个小程序」有五个跑的地方：全屏面板、右侧栏（**DSH 原生右栏那一格**）、
// 本会话页签、会话右上角浮窗（**DSH 原生悬浮**）、浏览器新页签。前四个跑的是
// **同一个运行页组件**（RunnerView）—— 同一条沙箱串、同一个 `src=SERVE/…`，
// 只有露出来的动作按 `chrome` 分档；没有第二份 iframe 实现。
//
// **并列与悬浮这两面在 2026-09 换过地基**：它们以前是我们自己画的（`details` 那一列、
// 右上角一个有界窗口 + 拖动/缩放/量高），现在都交给 DSH 自己的右栏能力 ——
// 我们只往 `sidebar.right.pane.tab` 登记一格（`MiniAppRightbarPane`），悬浮求
// `sidebarRight.float()` 并**读回确认**。自绘那一套（449 行组件 + 198 行几何 +
// 12 个导出）已整体退役：拿不到原生能力时这两面**如实失败**（一条 toast），
// 而不是退回一个谁都不再维护的窗口。
//
// 五个地方**互相可达**：每个跑着的头的右上角都有同一排「切换布局」按钮（`LAYOUT_PLACES`），
// 站在任何一个地方都能一下切到别的任何一个，不必退回面板重来；当前所在的那一枚带
// `aria-pressed` 且点自己不做事。那排按钮只画界面，动作全在 `switchLayout` 里。
//
// 运行页的 iframe 与 NomiFun 原版共用同一条沙箱授权串，且这里刻意加上
// `allow-same-origin` 的反面：文档是生成出来的代码，给了同源就等于取消沙箱。
// 模板缩略图同理，用的是同一个 IFRAME_SANDBOX 常量。

window.__ModuleLoader__.load({
	id: "dsh-miniapp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useCallback = React.useCallback;
		var useMemo = React.useMemo;

		/** 插件名，必须与宿主半边一致。 */
		var name = "dsh-miniapp";
		/** 依赖的客户端服务：槽位注册表与文案。 */
		var inject = ["slots", "locale"];

		/**
		 * HTTP 前缀，与宿主半边的两个常量一致。
		 *
		 * 刻意分成两个窄前缀：宿主那边如果占用整个 `/plugins/dsh-miniapp`，
		 * 就会在「最长前缀优先」里赢过 DSH 自己的 `/plugins` 路由，
		 * 把本文件（`/plugins/dsh-miniapp/client.js`）一起吞掉 —— 面板永远不会出现。
		 */
		var API = "/plugins/dsh-miniapp/api";
		/** 沙箱直出通道前缀，与宿主半边的 SERVE_PREFIX 一致。 */
		var SERVE = "/plugins/dsh-miniapp/serve";
		/** iframe 授权串，必须与宿主半边的 IFRAME_SANDBOX 一致。 */
		var IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";
		/** 判定 iframe 卡住的宽限时间（毫秒）。 */
		var WATCHDOG_MS = 6000;
		/**
		 * 跨浮层那条提示（toast）的存活时间（毫秒）。
		 *
		 * 它比浮层内部那条 3.2 秒的回执长一点：这条提示出现在**浮层关闭之后**，
		 * 用户的眼睛刚离开浮层、正要去找上方页签，太短会正好错过。
		 */
		var TOAST_MS = 6000;
		/** 文案命名空间。 */
		var NS = "miniapp";
		/**
		 * 会话页签那一格。
		 *
		 * `conversation.view` 是 `kind: "list"` + `scope: "session"` 的**正规座位**
		 * （DSH 的会话头部就在它上面画 `role="tablist"`，身体只渲染当前激活的那一个），
		 * 所以用自己独有的 id 加一格是"增加"，不是"替换"。order 20 排在 chat(0) 与
		 * trajectory(10) 之后。
		 */
		var VIEW_SLOT = "conversation.view";
		// ----------------------------------------------- DSH 原生右栏（方案 B 的"并列"那一面）
		//
		// `sidebar.right.pane.tab` 是 **keyed + session** 的**加法**座位：按 `key` 加一格，
		// 不会顶掉 DSH 自己的 Files / 预览（t31 在已装 asar 里核实：那里已有 3 个不同 key 并存）。
		// `key` 必须**逐字等于** tab 类型的 id —— 这是同一件事的第二次书写，两边写歪了就接不上。
		var RIGHTBAR_PANE_SLOT = "sidebar.right.pane.tab";
		/** 我们那个 tab 类型的 id / kind：`register({ id, kind })` 与座位 `key` 都用它。 */
		var RIGHTBAR_VIEW_ID = "dsh-miniapp";
		var RIGHTBAR_VIEW_KIND = "miniapp";
		/** 登记优先级用默认档（不与别人抢；DSH 的 `DEFAULT_BAND`）。 */
		var RIGHTBAR_VIEW_PRIORITY = 0;

		var VIEW_ID = "miniapp";
		var VIEW_ORDER = 20;

		/**
		 * 文案表：嵌套书写，注册前展平。
		 *
		 * 为什么必须展平：DSH 的查找是 `locales.get(locale)?.[key]` ——
		 * **一次直接属性访问，没有点分路径解析**（见 @deepseek-ai/dsh-client-locale
		 * 的 `lookup(ns, key, chain)`）。所以表里必须有 `"actions.open": "打开使用"`
		 * 这样的扁平键；写成嵌套对象时 `t("actions.open")` 会一路回退，最后把**键名本身**
		 * 显示给用户（这正是「按钮都是英文」的实际原因）。DSH 内置表同样是扁平的
		 * （`"ok": "确定"`）。
		 *
		 * 嵌套只是为了源码可读：137 个平铺键没法读。注册前拍平。
		 */
		var COPY = {
						zh: {
							title: "小程序",
							subtitle: "AI 生成、随开随用的网页小工具",
							nav: { entry: "小程序" },
							list: {
								searchPlaceholder: "搜索小程序",
								updatedAt: "更新于 {time}",
								filterEmpty: "没有匹配的小程序",
								loading: "正在加载…",
								neverPublished: "尚未发布"
							},
							time: {
								justNow: "刚刚",
								minutesAgo: "{count} 分钟前",
								hoursAgo: "{count} 小时前",
								yesterday: "昨天",
								daysAgo: "{count} 天前",
								weeksAgo: "上周"
							},
							empty: {
								title: "还没有小程序",
								description: "在任意会话里让 AI「做一个小程序」：它会创建一个自包含的单文件网页小工具，写完在预览里点「发布」，就会出现在这里。已经写好的 HTML 也可以直接导入。",
								cta: "去创建"
							},
							actions: {
								open: "打开使用",
								rename: "重命名",
								delete: "删除",
								refresh: "刷新",
								retry: "重试",
								openInBrowser: "在浏览器中打开",
								dismissHint: "忽略提示",
								back: "返回",
								close: "关闭",
								cancel: "取消",
								confirm: "确定",
								// 「创建小程序」现在是一条**直达链路**：关浮层 → 开一个新的空白会话 →
								// 在输入框里预置 `/create-miniapp` 技能标签（见 create 回调）。
								create: "创建小程序"
							},
							// 自绘浮窗那两个把手上的说明文字（拖动 / 缩放）。
							// **2026-09 起没有消费者**：拖动、缩放、手柄全部随自绘浮窗退役。
							// 文案键留在 zh/en 两张表里是**有意**的 —— 双语表是"我们认识哪些话"
							// 的总表，删掉会让下一个想画拖动手柄的人只找到一半。
							corner: {
								dragHint: "拖动移动位置，双击复位",
								resize: "调整大小"
							},
							create: {
								prompt: "请帮我做一个小程序 —— 一个自包含的单文件网页小工具。\n\n我想要的是：（在这里描述你的想法，例如：一个带提醒的番茄钟 / 一个记账本 / 一个倒计时）\n\n要求：界面现代美观、打开即用、不需要任何构建步骤。做完之后提醒我去「小程序」面板点「发布」。",
								copied: "创建提示词已复制，粘贴到任意会话即可开始",
								// 降级路径的**唯一**一句话：新会话已经开了，但输入框填不进去。
								// 浮层此时已经关了，所以它只能走 `ui.toast`（浮层里的 notice 看不见）。
								writeFailed: "这个 DSH 版本没法自动把指令填进输入框；创建提示词已复制到剪贴板，粘贴到任意会话即可开始。"
							},
							rename: { title: "重命名小程序", placeholder: "输入新名称", success: "已重命名" },
							delete: { confirmTitle: "删除小程序", confirmContent: "确定删除「{name}」吗？删除后不可恢复。", success: "已删除" },
							iterate: {
								toggle: "继续迭代",
								prompt: "请帮我继续改这个小程序。\n\n- 名称：{name}\n- 小程序 id：{id}\n- 源码路径：{path}\n\n注意：源码在会话工作区之外，直接用 read/write 工具会被默认的文件沙箱拒绝（这不是错误）。请改用小程序自己的工具：\n1. 先用 miniapp_read_source 完整读一遍，不要凭猜改。\n2. 改完用 miniapp_write_source 写回完整的一版 —— 它是整份替换，不是增量编辑。\n3. 它必须保持自包含：CSS 与 JavaScript 内联在文件里，需要第三方库时走 CDN。\n4. 每轮回复结束时它都要是完整可运行的版本。\n5. 改完不会自动生效：请提醒我去「小程序」面板点「发布」。",
								copied: "迭代指令已复制，粘贴给任意会话即可继续改",
								failed: "打不开迭代入口：{message}"
							},
							publish: {
								action: "发布",
								publishing: "发布中…",
								pending: "有未发布改动",
								explain: "当前运行的是已发布版本；工作副本里的改动要点「发布」才会生效。",
								failed: "发布失败：{message}"
							},
							// 「从未发布过」的空态（运行页主体）。它只在这一种情况下出现：
							// 直出通道对这个 id 只有 404，所以没有东西可以画。
							notPublished: {
								title: "还没有发布过",
								body: "预览里暂时没有可运行的内容 —— 点下面的「发布」把它上线，就能在这里直接运行。"
							},
							frame: { stalledHint: "小程序还没渲染出来？可以重试，或在浏览器中打开。" },
							import: {
								entry: "导入小程序",
								title: "导入小程序",
								intro: "把你已经写好的网页应用托管进来。小程序只提供一个自包含的 HTML 文档：CSS 与 JavaScript 要写在文件里，第三方库可以走 CDN。",
								pastePlaceholder: "把 HTML 粘贴到这里，或从下面选择一个 .html 文件…",
								pickFile: "选择 HTML 文件",
								pickFileHint: "单个 .html / .htm 文件",
								sourceFile: "{name}（{size}）",
								validate: "校验",
								validating: "正在校验…",
								clean: "校验通过，没有发现问题。",
								action: "导入",
								success: "已导入「{name}」",
								successWithFixes: "已导入「{name}」，导入时自动处理：{items}",
								appliedFixes: "导入时已自动处理：{items}",
								convert: "复制改造提示词",
								convertCopied: "改造提示词已复制，粘贴给任意会话即可",
								convertHint: "改造会新开一个会话：把上面这些问题交给 AI，让它把你的应用改写成一个自包含的单文件小程序，写完再发布进来。",
								convertPrompt: "我有一个已经写好的网页应用，想把它改造成一个自包含的单文件小程序（一个 HTML 文件，CSS 与 JavaScript 全部内联，第三方库走 CDN，不需要任何构建步骤，不能依赖其他本地文件）。\n\n当前校验发现这些问题需要解决：\n{findings}\n\n请帮我改写成一个完整的单文件 HTML 文档：所有本地依赖内联进去（图片转成 data URI），去掉指向本机开发服务器的地址，去掉服务端模板语法，把裸包名导入换成 CDN 完整地址或 importmap。运行环境是 sandbox 且没有 allow-same-origin（来源不透明），cookie、同源请求、localStorage 都可能不可用或抛错，相关代码一律 try/catch 并优雅降级。",
								severity: {
									fatal: "必须先解决（{total}）",
									autofix: "导入时自动处理（{total}）",
									warning: "注意（{total}）"
								},
								errors: {
									validateFailed: "校验失败：{message}",
									importFailed: "导入失败：{message}",
									blocked: "导入被拒绝：先按下面的问题处理，或者复制改造提示词交给 AI。",
									readFailed: "读取所选文件失败：{message}",
									copyFailed: "复制失败：{message}"
								},
								rules: {
									empty_payload: { title: "内容是空的", fix: "这个来源里没有任何可校验的内容。请选择真正的 HTML 文件。" },
									size_over_limit: { title: "文档太大", fix: "文档大小 {detail}，超过 4 MiB 上限。把内联的大图或大段数据去掉（改用 CDN 或外链），再导入一次。" },
									not_html: { title: "这不是一个 HTML 文档", fix: "内容看起来是脚本、样式或数据，不是网页。请选择应用的 HTML 入口文件。" },
									no_root_document: { title: "文件夹里找不到入口页面", fix: "把入口页面命名为 index.html，或者直接选中那个 HTML 文件。" },
									fragment_not_document: { title: "只是一段 HTML 片段", fix: "缺少 html / body 外壳。导入时会自动补成完整文档，你不需要改。" },
									local_ref_unsupported: { title: "引用了本地文件", fix: "引用 {detail} 加载不到：小程序只对外提供一个文档，即使这个文件和它一起导入也不会被提供。请把它并进这一个文件（CSS/JS 直接写进去，小图片转成 data URI）。" },
									dev_server_ref: { title: "指向了本机开发服务器", fix: "{detail} 只在你本地的开发服务器运行时才有效。把它换成写进文件的内容，或者公网可访问的 CDN 地址。" },
									framework_source_entry: { title: "这是需要构建的框架源码", fix: "Vue / React / Svelte 这类源码入口必须先打包才能运行。请先构建，再导入产物里的单页 HTML；或者让 AI 重写成单文件。" },
									server_template_markers: { title: "含有服务端模板语法", fix: "发现模板标记 {detail}，它要靠服务端渲染才会变成 HTML。请导入渲染之后的页面，或者把数据直接写进静态 HTML。" },
									esm_bare_specifier: { title: "模块脚本里有裸包名导入", fix: "从 {detail} 这样的裸包名导入，浏览器里解析不了。改成 CDN 的完整地址，或者加一个 importmap 把它映射过去。" },
									external_cdn_ref: { title: "用到了外部 CDN 资源", fix: "可以导入，但要联网才能用：断网或 CDN 不可达时会退化。关键资源建议直接写进文件。" },
									web_storage_use: { title: "用到了浏览器存储", fix: "小程序运行在沙箱里、来源不透明，localStorage 这类接口可能直接抛错。存取都请包在 try/catch 里，核心功能不要依赖它。" },
									nested_iframe_embed: { title: "内部还嵌了 iframe", fix: "嵌套的 iframe 会继承同一套沙箱限制，很多站点也不允许被嵌入，可能显示一片空白。请为加载失败准备兜底内容。" },
									unknown: { title: "未知的校验项（{ruleId}）", fix: "这个版本的客户端还不认识这条规则。请升级 DSH 后再看，或者把这条问题交给会话里的 AI 处理 —— 它是真实存在的，只是这里不知道怎么解释它。" }
								}
							},
							// composer 上的「小程序模式」：chip、模板面板与它的三种空态。
							mode: {
								chip: "小程序",
								exit: "退出小程序模式",
								region: "小程序模式",
								// 输入框旁那一格显示的是"你选了什么"，不是模式开关。
								selectedTemplate: "已选模板",
								removeTemplate: "取消选择模板"
							},
							templates: {
								categories: "模板分类",
								loading: "正在加载模板…",
								empty: "这个分类下还没有模板",
								retry: "重新加载",
								loadFailed: "模板加载失败：{message}",
								previewLoading: "正在准备预览…",
								previewFailed: "预览打不开",
								select: "用这个模板",
								selected: "已选用",
								hint: "选一个模板：它的描述会填进输入框 —— 可以直接回车，也可以先改一改。",
								selectedHint: "「{name}」已填进输入框 —— 直接回车，或者改成你想要的样子。",
								// 「直接创建」是另一条路：不经过模型，拿模板自己的正文建。见 createNow。
								createNow: "直接创建",
								creating: "创建中…",
								createNowTitle: "不用 AI，直接用这个模板建一个小程序",
								created: "已创建「{name}」—— 打开小程序面板就能用；想改就让 AI 继续迭代。",
								createFailed: "创建失败：{message}",
								writeFailed: "这个 DSH 版本没法自动填入输入框；模板描述已复制到剪贴板，粘贴即可。",
								category: {
									all: "全部",
									// 分类按「意图」命名，不按学科命名：tabs 的读者是「不知道该要
									// 什么」的人，所以它读起来得像一句需求的开头，而不是一个目录名。
									timer: "计个时",
									note: "记点事",
									calc: "算个数",
									decide: "帮我想",
									play: "看着玩",
									unknown: "其他"
								}
							},
							// 会话页签（`conversation.view` 座位上那一格）。
							//
							// 它与另外三个浮层的区别是本质性的：它是**会话主体的一部分**，
							// 占满会话区、和「会话」「轨迹」并排；浮层则是盖在上面的东西。
							view: {
								tab: "小程序",
								pick: "选一个小程序，它就在这个页签里跑起来。",
								empty: "还没有已发布的小程序。先在「小程序」面板里创建或导入一个，再回到这里。"
							},
							// 标题栏右侧那一栏（Chrome 扩展程序按钮 + 下拉面板那套）。
							bar: {
								title: "小程序",
								// 面板最下面那一条：整个小程序库的入口。
								manage: "管理小程序",
								// 两个分区标题。
								sectionPinned: "固定的小程序",
								sectionAll: "全部小程序",
								// 固定区为空时那一行 —— 分区标题不能开着天窗。
								emptyPinned: "还没有固定的",
								// 整个库为空时的那一句（不是空白，也不是一句「正在加载」）。
								empty: "还没有小程序。到最下面的「管理小程序」里创建或导入一个。",
								// 面板里第一行：有固定时是「打开谁」。
								openPinned: "打开「{name}」",
								// 标题栏那一颗（也是唯一一颗）：四个方块，点开小程序栏。
								entry: "小程序栏",
								menu: "更多操作",
								pin: "固定到标题栏",
								unpin: "取消固定",
								// ⋮ 菜单里那两项（第三项复用 `actions.openInBrowser`）。
								//
								// 它们**不复用**「切换布局」那排按钮的 `layout.place.*`：
								// 那边是**名词**（"右侧栏"），回答的是"我现在在哪个坑里"；
								// 这边是**动词短语**（"在右侧打开"），回答的是"把这一条送到哪里去"。
								// 同一件事在两个语境里本来就是两种说法，硬合成一句两边都别扭。
								open: {
									drawer: "在右侧打开",
									session: "在本会话页签打开"
								}
							},
							// 五个「跑的地方」——「切换布局」那五枚按钮的名字，以及切页签的降级文案。
							//
							// 键与 `LAYOUT_PLACES` 里的 `labelKey` 一一对应，顺序也一致：
							// 面板 → 右侧栏 → 本会话页签 → 右上浮窗 → 浏览器新页签。
							// 五个名字是**名词**（"右侧栏"）而不是动词短语（"在右侧打开"）：
							// 这排按钮要回答的是"我现在在哪个坑里"，其中一个还是当前所在的那一个。
							layout: {
								label: "切换布局",
								place: {
									panel: "全屏面板",
									drawer: "右侧栏",
									session: "本会话页签",
									corner: "右上浮窗",
									browser: "浏览器新页签"
								}
							},
							open: {
								// 切页签要碰 DSH 的内部服务，拿不到时不能静默 —— 这句话就是"怎么办"。
								placed: "已放到本会话的「小程序」页签 —— 点会话头部的页签切过去。",
								noSession: "拿不到当前会话，没能放进页签。先在左侧选中一个会话再试。",
								missing: "这个小程序已经不在了。",
								// 并列 / 悬浮那一面要用 DSH 的原生右栏服务，老宿主上没有 —— 不能静默。
								rightbarUnavailable: "这个 DSH 版本没有原生右栏服务，暂时打不开右侧栏或悬浮窗。"
							},
							errors: {
								loadListFailed: "加载小程序列表失败：{message}",
								actionFailed: "操作失败：{message}"
							}
						},
						en: {
							title: "MiniApps",
							subtitle: "AI-generated web tools, ready the moment you open them",
							nav: { entry: "MiniApps" },
							list: {
								searchPlaceholder: "Search mini-apps",
								updatedAt: "Updated {time}",
								filterEmpty: "No mini-app matches",
								loading: "Loading…",
								neverPublished: "Not published yet"
							},
							time: {
								justNow: "just now",
								minutesAgo: "{count} min ago",
								hoursAgo: "{count} h ago",
								yesterday: "yesterday",
								daysAgo: "{count} d ago",
								weeksAgo: "last week"
							},
							empty: {
								title: "No mini-apps yet",
								description: "Ask the agent in any session to build one: it creates a self-contained single-file web tool, and once you publish it, it shows up here. You can also import an HTML file you already wrote.",
								cta: "Create one"
							},
							actions: {
								open: "Open",
								rename: "Rename",
								delete: "Delete",
								refresh: "Refresh",
								retry: "Retry",
								openInBrowser: "Open in browser",
								dismissHint: "Dismiss",
								back: "Back",
								close: "Close",
								cancel: "Cancel",
								confirm: "Confirm",
								create: "Create mini-app"
							},
							// 与 zh 一一对应（文案表双语对称是一条被测试钉着的契约）。
							corner: {
								dragHint: "Drag to move, double-click to reset",
								resize: "Resize"
							},
							create: {
								prompt: "Please build me a mini-app — a self-contained single-file web tool.\n\nWhat I want: (describe it here — e.g. a pomodoro timer with reminders / an expense tracker / a countdown)\n\nRequirements: a modern, good-looking UI; usable the moment it opens; no build step. When you are done, remind me to press Publish in the MiniApps panel.",
								copied: "Creation prompt copied — paste it into any session to start",
								writeFailed: "This DSH build cannot fill the composer for you; the creation prompt is on your clipboard — paste it into any session to start."
							},
							rename: { title: "Rename mini-app", placeholder: "New name", success: "Renamed" },
							delete: { confirmTitle: "Delete mini-app", confirmContent: "Delete “{name}”? This cannot be undone.", success: "Deleted" },
							iterate: {
								toggle: "Keep iterating",
								prompt: "Please keep improving this mini-app.\n\n- Name: {name}\n- Mini-app id: {id}\n- Source path: {path}\n\nNote: the source lives outside the session workspace, so a direct read/write is refused by the default file sandbox (that is not an error). Use the mini-app's own tools instead:\n1. Read it in full with miniapp_read_source first; do not guess.\n2. Write the complete new version back with miniapp_write_source — it replaces the whole file, it is not an incremental edit.\n3. It must stay self-contained: CSS and JavaScript inline, third-party libraries via CDN.\n4. It must be a complete, runnable version at the end of every turn.\n5. Changes do not go live automatically: remind me to press Publish in the MiniApps panel.",
								copied: "Iteration prompt copied — paste it into any session to continue",
								failed: "Could not open the iteration entry: {message}"
							},
							publish: {
								action: "Publish",
								publishing: "Publishing…",
								pending: "Unpublished changes",
								explain: "What runs is the published version; changes in the working copy go live only after you press Publish.",
								failed: "Publish failed: {message}"
							},
							// 「从未发布过」的空态（运行页主体）。它只在这一种情况下出现：
							// 直出通道对这个 id 只有 404，所以没有东西可以画。
							notPublished: {
								title: "Not published yet",
								body: "There is nothing to run in the preview yet — press Publish below to put it live, and it will run right here."
							},
							frame: { stalledHint: "Mini-app not rendering? Retry, or open it in your browser." },
							import: {
								entry: "Import",
								title: "Import a mini-app",
								intro: "Host a web app you already wrote. A mini-app is one self-contained HTML document: CSS and JavaScript live in the file, third-party libraries may come from a CDN.",
								pastePlaceholder: "Paste HTML here, or pick a .html file below…",
								pickFile: "Choose HTML file",
								pickFileHint: "a single .html / .htm file",
								sourceFile: "{name} ({size})",
								validate: "Validate",
								validating: "Validating…",
								clean: "Validation passed with no findings.",
								action: "Import",
								success: "Imported “{name}”",
								successWithFixes: "Imported “{name}”; fixed automatically: {items}",
								appliedFixes: "Fixed automatically on import: {items}",
								convert: "Copy rewrite prompt",
								convertCopied: "Rewrite prompt copied — paste it into any session",
								convertHint: "Rewriting starts a new session: hand these findings to the agent, have it rewrite your app into a self-contained single-file mini-app, then publish it here.",
								convertPrompt: "I have an existing web app and want it rewritten as a self-contained single-file mini-app (one HTML file, CSS and JavaScript inlined, third-party libraries via CDN, no build step, no other local files).\n\nValidation found these problems to solve:\n{findings}\n\nPlease rewrite it into one complete HTML document: inline every local dependency (images as data URIs), drop dev-server URLs, drop server-side template syntax, and replace bare module specifiers with full CDN URLs or an import map. The runtime is sandboxed without allow-same-origin (opaque origin), so cookies, same-origin requests and localStorage may be unavailable or throw — wrap those in try/catch and degrade gracefully.",
								severity: {
									fatal: "Must fix first ({total})",
									autofix: "Handled on import ({total})",
									warning: "Worth knowing ({total})"
								},
								errors: {
									validateFailed: "Validation failed: {message}",
									importFailed: "Import failed: {message}",
									blocked: "Import refused: fix the findings below, or copy the rewrite prompt and hand it to the agent.",
									readFailed: "Could not read the chosen file: {message}",
									copyFailed: "Copy failed: {message}"
								},
								rules: {
									empty_payload: { title: "The content is empty", fix: "There is nothing to validate in this source. Pick a real HTML file." },
									size_over_limit: { title: "Document too large", fix: "It is {detail}, over the 4 MiB ceiling. Remove large inline images or data, or move them to a CDN, then import again." },
									not_html: { title: "This is not an HTML document", fix: "It looks like a script, stylesheet or data, not a page. Pick the app's HTML entry file." },
									no_root_document: { title: "No entry page in the folder", fix: "Name the entry page index.html, or select that HTML file directly." },
									fragment_not_document: { title: "This is an HTML fragment", fix: "It has no html/body shell. NomiFun wraps it into a full document on import — you do not need to change anything." },
									local_ref_unsupported: { title: "It references local files", fix: "{detail} cannot load: a mini-app serves exactly one document, so a sibling file is not served even when it is imported alongside. Fold it into this one file (inline the CSS/JS, turn small images into data URIs)." },
									dev_server_ref: { title: "It points at a local dev server", fix: "{detail} only works while your dev server runs. Replace it with content written into the file, or a publicly reachable CDN URL." },
									framework_source_entry: { title: "This is unbuilt framework source", fix: "A Vue / React / Svelte source entry must be bundled first. Build it and import the resulting single-page HTML, or have the agent rewrite it as one file." },
									server_template_markers: { title: "It contains server-side template syntax", fix: "Found {detail}, which needs a server to render into HTML. Import the rendered page, or write the data straight into static HTML." },
									esm_bare_specifier: { title: "A module script imports a bare package name", fix: "A browser cannot resolve a bare specifier like {detail}. Use a full CDN URL, or add an import map." },
									external_cdn_ref: { title: "It uses external CDN assets", fix: "Importable, but it needs the network: offline or with the CDN unreachable it degrades. Inline anything critical." },
									web_storage_use: { title: "It uses browser storage", fix: "The mini-app runs sandboxed with an opaque origin, so localStorage and friends may throw. Wrap access in try/catch and keep core behaviour independent of it." },
									nested_iframe_embed: { title: "It embeds another iframe", fix: "A nested iframe inherits the same sandbox limits and many sites refuse to be framed, so it may render blank. Provide fallback content." },
									unknown: { title: "Unrecognised finding ({ruleId})", fix: "This client build does not know this rule yet. Update DSH, or hand the finding to the agent in a session — it is real, this build just cannot explain it." }
								}
							},
							// The blank-session "MiniApp mode" on the composer: chip, panel, empty states.
							mode: {
								chip: "MiniApp",
								exit: "Leave MiniApp mode",
								region: "MiniApp mode",
								selectedTemplate: "Selected template",
								removeTemplate: "Clear template selection"
							},
							templates: {
								categories: "Template categories",
								loading: "Loading templates…",
								empty: "No templates in this category",
								retry: "Reload",
								loadFailed: "Could not load templates: {message}",
								previewLoading: "Preparing preview…",
								previewFailed: "Preview unavailable",
								select: "Use this template",
								selected: "Selected",
								hint: "Pick a template: its description lands in the input box — press enter, or edit it first.",
								selectedHint: "“{name}” is in the input box — press enter, or make it yours.",
								createNow: "Create now",
								creating: "Creating…",
								createNowTitle: "Build a mini-app from this template directly, without the model",
								created: "Created “{name}” — open the MiniApp panel to use it, or ask the AI to iterate.",
								createFailed: "Could not create it: {message}",
								writeFailed: "This DSH build cannot fill the input box; the template description is on your clipboard — just paste it.",
								category: {
									all: "All",
									// Named for the intent, not the discipline — see the zh table.
									timer: "Time it",
									note: "Jot it",
									calc: "Do the math",
									decide: "Help me pick",
									play: "Just for fun",
									unknown: "Other"
								}
							},
							// The Session tab (`conversation.view`): part of the Session body, not an overlay.
							view: {
								tab: "MiniApp",
								pick: "Pick a mini-app to run it in this tab.",
								empty: "No published mini-apps yet. Create or import one in the MiniApps panel, then come back."
							},
							// The bar on the right of the Session header (Chrome's extensions button + dropdown).
							// Mirrors the zh table key for key — that symmetry is a tested contract.
							bar: {
								title: "MiniApps",
								manage: "Manage mini-apps",
								sectionPinned: "Pinned mini-apps",
								sectionAll: "All mini-apps",
								emptyPinned: "Nothing pinned yet",
								empty: "No mini-apps yet. Create or import one under “Manage mini-apps” at the bottom.",
								openPinned: "Open “{name}”",
								entry: "MiniApps bar",
								menu: "More actions",
								pin: "Pin to the header",
								unpin: "Unpin",
								// Deliberately NOT the layout switcher's `layout.place.*`: those are nouns
								// ("Right panel") answering "where am I", these are verbs answering
								// "where do I send this one". See the zh table.
								open: {
									drawer: "Open on the right",
									session: "Open in this session's tab"
								}
							},
							// The five places a mini-app can run — the names on the layout switcher,
							// plus the copy used when placing it in the Session tab fails.
							layout: {
								label: "Switch layout",
								place: {
									panel: "Full panel",
									drawer: "Right panel",
									session: "This session's tab",
									corner: "Corner window",
									browser: "Browser tab"
								}
							},
							open: {
								placed: "Placed in this session's MiniApp tab — switch to it with the tab in the session header.",
								noSession: "Could not determine the current session, so it was not placed in a tab. Select a session in the sidebar and try again.",
								missing: "This mini-app is gone.",
								// 英文侧必须与中文逐键对称 —— 否则取到裸键名（见文案表那一段）。
								rightbarUnavailable: "This DSH build has no native side-panel service, so the right column / floating window is unavailable for now."
							},
							errors: {
								loadListFailed: "Could not load the mini-app list: {message}",
								actionFailed: "Action failed: {message}"
							}
						}
					};

		/** 把嵌套文案表展平成 DSH 要求的点分扁平键。 */
		function flattenCopy(table, prefix, out) {
			var result = out || {};
			var head = prefix ? prefix + "." : "";
			Object.keys(table).forEach(function (key) {
				var value = table[key];
				if (value !== null && typeof value === "object") {
					flattenCopy(value, head + key, result);
				} else {
					result[head + key] = value;
				}
			});
			return result;
		}
		/**
		 * 这一版认识的导入规则（与服务端 IMPORT_RULE_IDS 对齐）。
		 *
		 * 它存在的意义是**兜底**：服务端新增一条规则时，旧客户端不该把裸 rule_id
		 * 甩给用户，而应该说清楚"这个版本还不认识它"并回显 id —— 降级而不是丢弃。
		 */
		var KNOWN_IMPORT_RULES = [
			"empty_payload", "size_over_limit", "not_html", "fragment_not_document",
			"local_ref_unsupported", "dev_server_ref", "framework_source_entry",
			"server_template_markers", "esm_bare_specifier", "external_cdn_ref",
			"web_storage_use", "nested_iframe_embed"
		];

		/** 找到一条 finding 该用哪套文案：认识的用自己那套，不认识的落到 unknown。 */
		function ruleCopyKey(ruleId) {
			return KNOWN_IMPORT_RULES.indexOf(ruleId) >= 0 ? ruleId : "unknown";
		}

		// ---------------------------------------------------------------- 主题
		//
		// 与原版的 token 一一对应：原版用 Arco 的 `--color-*` / `primary-6`，
		// 这里换成 DSH 的 `--dsw-alias-*`。原版大量使用
		// `rgba(var(--primary-6), 0.12)` 这种半透明层，而 DSH 的 token 是完整颜色、
		// 塞不进 rgba()，所以用 color-mix 表达同一个意思。

		var T = {
			bgBase: "var(--dsw-alias-bg-base)",
			bgLayer1: "var(--dsw-alias-bg-layer-1)",
			fill: "var(--dsw-alias-bg-layer-2)",
			border1: "var(--dsw-alias-border-l1)",
			border2: "var(--dsw-alias-border-l2)",
			text1: "var(--dsw-alias-label-primary)",
			text2: "var(--dsw-alias-label-secondary)",
			/**
			 * 三级文字色。原来只有浮窗的缩放手柄用（静默时它应当退到背景里，
			 * 悬停/拖动时才浮出来）。token 名取自 DSH 客户端主题表的
			 * `--dsw-alias-label-tertiary` —— 不自己发明颜色，跟着主题走。
			 */
			text3: "var(--dsw-alias-label-tertiary)",
			brand: "var(--dsw-alias-brand-primary)",
			/**
			 * 实心主按钮的三个颜色 —— **照抄 DSH 客户端自己的主按钮**，不自己发明。
			 *
			 * 出处是 DSH 自己编译出来的样式表（`@deepseek-ai/dsh-client-ui-*` 的
			 * `lib/client.js`，类名带哈希，模式是 `.<hash>_primaryButton`）：
			 *
			 *   .…_primaryButton{ … background: var(--dsw-alias-button-primary-fill);
			 *                          color: var(--dsw-alias-label-primary-foreground) }
			 *   .…_primaryButton:hover:not(:disabled){ background: var(--dsw-alias-button-primary-hover) }
			 *
			 * 三个 token 在 DSH 的主题表（dsh-client-ui-theme）里是一条闭环的别名链：
			 *
			 *   --dsw-alias-button-primary-fill   = --dsw-alias-brand-primary
			 *   浅色主题：brand=#0f1115（近黑），hover=bluish-750 #43454a，foreground=#fff
			 *   深色主题：brand=#f9fafb（近白），hover=bluish-100 #ebeef2，foreground=#0f1115
			 *
			 * 关键在最后一行：`--dsw-alias-label-primary-foreground` 是**跟着主题翻面**的
			 * 那一半（浅色给白、深色给近黑），填上去正好压在 brand 那半上。
			 * 这正是"白底白字"缺的那一半，而且它是 DSH 自己的取值，不是我们发明的。
			 *
			 * 两个 fallback 是防御性的：这三条别名与 brand 同在一个主题块里出现，
			 * 所以更老的 DSH 上要么全有要么全无；真取不到时退回 brand / bgLayer2，
			 * 结果与改造前逐像素相同，不会画出透明底。
			 */
			buttonFill: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))",
			buttonHover: "var(--dsw-alias-button-primary-hover, var(--dsw-alias-bg-layer-2))",
			/**
			 * 画在实心按钮底色上的文字色。
			 *
			 * 用 DSH 主按钮自己的 `--dsw-alias-label-primary-foreground`，**不是**
			 * `--dsw-alias-brand-primary-invert`：实测 -invert 与 brand 在同一个主题下
			 * 取值完全相同，它根本不是"反面"，救不了白底白字。
			 *
			 * 这个名字现在覆盖两处实心按钮：主按钮（brand 底）与危险按钮（danger 底）。
			 * 两个底色在两套主题下的明度都够远（dark 的 danger 是偏亮的 #f25a5a，
			 * foreground 是近黑 #0f1115；light 的 danger 是深红 #ec1313，foreground 是白），
			 * 所以同一个 foreground 两边都读得出来。
			 */
			onBrand: "var(--dsw-alias-label-primary-foreground)",
			/** 说明性小字。PPT 的分类 tab 未选中态用的就是它。 */
			caption: "var(--dsw-alias-label-caption)",
			/**
			 * 半透明的悬停/选中底。
			 *
			 * 它是一层 `rgba` 面纱而不是实色，所以贴在任意底色上都成立、也不会盖掉下面那层。
			 * DSH 自己的 chip / tab 选中态用的就是它（PPT 的分类 tab 也是）。
			 */
			hoverSurface: "var(--dsw-alias-interactive-bg-hover)",
			warn: "var(--dsw-alias-state-warn-primary)",
			success: "var(--dsw-alias-state-success-primary)",
			danger: "var(--dsw-alias-state-error-primary)"
		};

		/** 第三级文字：DSH 没有 tertiary token，用 secondary 降透明度表达层次。 */
		var TEXT3 = { color: T.text2, opacity: 0.72 };
		/** `rgba(var(--x), n)` 的 DSH 等价写法。 */
		function tint(color, percent) {
			return "color-mix(in srgb, " + color + " " + percent + "%, transparent)";
		}

		// ---------------------------------------------------------------- 图标
		//
		// 内联 SVG，形状对齐原版用的 IconPark 图标（ApplicationOne / Right /
		// MagicWand / EditTwo / Delete / ArrowLeft / Refresh / Browser / Upload /
		// Search / Plus / Close）。不引图标库：客户端半边只 require("react")。

		var ICON_PATHS = {
			app: "M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z",
			right: "M10 6l6 6-6 6-1.4-1.4L13.2 12 8.6 7.4z",
			back: "M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z",
			wand: "M4.2 19.8 15.6 8.4l-1.4-1.4L2.8 18.4zM17.5 2l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1zM19.5 13l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
			edit: "M3 17.2V21h3.8L18 9.8 14.2 6zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.6 1.6 3.8 3.8z",
			trash: "M9 3v1H4v2h16V4h-5V3zm-4 5v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zm4 2h2v9H9zm4 0h2v9h-2z",
			refresh: "M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z",
			browser: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.9 0 3.6.9 4.7 2.3H7.3A6 6 0 0 1 12 4zm-6.8 4h13.6a8 8 0 0 1 .7 3H4.5a8 8 0 0 1 .7-3zM4.5 13h15a8 8 0 0 1-.7 3H5.2a8 8 0 0 1-.7-3zm2.8 5h9.4A6 6 0 0 1 12 20a6 6 0 0 1-4.7-2z",
			upload: "M12 3 7 8h3v6h4V8h3zM5 18h14v2H5z",
			search: "M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z",
			plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
			close: "M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z",
			check: "M9.55 17.6 4 12l1.4-1.4 4.15 4.15L18.6 5.6 20 7z",
			/**
			 * 「在本会话页签打开」：一个带标签页头的窗口。
			 *
			 * 三个新图标都是**用互不相交的子路径拼出来的**，没走"外框挖洞"那套：
			 * 挖洞要靠相反的绕向让 nonzero 填充规则生效，而路径字符串里看不出绕向，
			 * 下一个改图标的人只要顺手动一下点的顺序，洞就会自己合上。
			 */
			tab: "M3 4h18v6H3zM3 12h18v8H3z",
			/**
			 * 「全屏面板」：一个占满整幅的窗口 —— 外框 + 里面**铺满宽度**的那一块。
			 *
			 * 与 `side` / `corner` 是同一套画法（细外框 + 一块实心），只有实心块的位置
			 * 不同：`side` 在右半边、`corner` 在右上角、`panel` 横贯整个内部。
			 * 三枚摆在一起看，"占满 / 靠右 / 缩在角上"一眼就能分开。
			 */
			panel: "M3 4h18v2H3zM3 18h18v2H3zM3 4h2v16H3zM19 4h2v16h-2zM5 8h14v8H5z",
			/** 「在右侧打开」：一个窗口，右边那一列是实心的侧栏。 */
			side: "M3 4h18v2H3zM3 18h18v2H3zM3 4h2v16H3zM19 4h2v16h-2zM12 6h6v12h-6z",
			/** 「在会话右上角打开」：一个窗口，右上角还嵌着一个小窗口（画中画那层意思）。 */
			corner: "M3 4h18v2H3zM3 18h18v2H3zM3 4h2v16H3zM19 4h2v16h-2zM12 7h6v5h-6z",
			/**
			 * 缩放手柄的图案：三道由长到短的斜线。
			 *
			 * 它是唯一一个**描边**图标（其余都是 `fill: currentColor` 的实心路径），
			 * 因为斜线组成的角标只能靠 stroke 画出来。
			 *
			 * ⚠️ **这个图案现在没有消费者**（2026-09）：它原来给自绘浮窗右下角那个
			 * `ResizeGrip` 用，而那个手柄随自绘浮窗一起退役了（拖拽/缩放全部交给
			 * DSH 自己的悬浮能力）。留着它是**有意的**：`ICON_PATHS` 是一张"我们认识的
			 * 图案"总表，删掉一行不会报错、只会让下一个想画抓手的人找不到它。
			 * 哪天真要清理，请连这一行与这段说明一起删 —— 而不是只删路径。
			 */
			resize: "M9 5.5 5.5 9M12.5 5.5 5.5 12.5M16 5.5 5.5 16",
			/**
			 * 标题栏下拉面板里的四个图案。前两个是**同一个几何的两态**：📌 固定 / 未固定。
			 *
			 * `pin` 是实心那半（这一条已固定），`pinOutline` 是描边那半（还没固定）。
			 * 分成两条路径而不是"一条路径 + 降透明度"是有意的：空心与实心的差别在 14px 上
			 * 仍然一眼可辨，而降透明度只是把同一个实心图形变淡 —— 那是"禁用"，不是"未选中"。
			 */
			pin: "M12 3a4 4 0 0 0-4 4c0 1.5.8 2.7 1.7 3.4V13h4.6v-2.6C15.2 9.7 16 8.5 16 7a4 4 0 0 0-4-4zM11 13h2v6h-2z",
			/** 上面那个几何的描边版；`Icon` 的 `stroke` 参数按它画。 */
			pinOutline: "M8 7a4 4 0 0 1 8 0c0 1.5-.8 2.7-1.7 3.4V13H9.7v-2.6C8.8 9.7 8 8.5 8 7M12 13v6",
			/** 每一行末尾那个 ⋮：三个实心圆点，竖排。 */
			dots: "M12 4a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM12 10a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM12 16a2 2 0 1 0 0 4 2 2 0 1 0 0-4z",
			/** 面板最下面那条「管理小程序」上的齿轮（描边）：一圈 + 八根齿。 */
			gear: "M12 5.8a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 1 0 0-12.4M18.2 12h2.3M12 18.2v2.3M5.8 12H3.5M12 5.8V3.5M16.4 16.4l1.6 1.6M16.4 7.6l1.6-1.6M7.6 16.4l-1.6 1.6M7.6 7.6 6 6"
		};

		/**
		 * 一个图标。`size` 对应原版传给 IconPark 的像素尺寸。
		 *
		 * `stroke: true` 换成描边画法 —— 只有那两个"本身就该是一根线条"的图案用它
		 * （📌 的空心态、齿轮）。实心填充**画不出空心**：硬做要在路径里挖洞，
		 * 而挖洞靠的是子路径绕向，绕向在路径字符串里看不出来（见 ICON_PATHS 里那条警告）。
		 *
		 * 不传 `stroke` 时渲染出来的样式对象与改造前**逐字段相同**，所以既有图标一个没动。
		 */
		function Icon(props) {
			var stroked = props.stroke === true;
			return React.createElement("svg", {
				viewBox: "0 0 24 24",
				width: props.size,
				height: props.size,
				style: stroked
					? {
						display: "block", flex: "0 0 auto",
						fill: "none", stroke: "currentColor", strokeWidth: 1.7,
						strokeLinecap: "round", strokeLinejoin: "round"
					}
					: { display: "block", flex: "0 0 auto", fill: "currentColor" },
				"aria-hidden": "true"
			}, React.createElement("path", { d: ICON_PATHS[props.name] }));
		}

		// ------------------------------------------------------------ 跨槽位状态
		//
		// 侧栏入口与全屏浮层分属两个槽位，是两个互不相邻的组件；用一份模块级订阅
		// 状态把它们连起来，于是「打开」这个动作只有一个来源。

		/**
		 * 三个浮层的开关名。它们**互斥**，判决写在下面 `set` 里那一个地方。
		 *
		 * 为什么必须互斥：每个浮层里都是一个真的在跑的小程序（`<iframe src=SERVE/…>`），
		 * 同一个文档同时跑两遍意味着两份定时器、两份计算 —— 而用户只会看其中一个。
		 * 所以"打开一个"就关掉另外两个，而不是让它们叠着。
		 *
		 * 会话页签不在这张名单里：它不是浮层，是会话主体的一部分，关掉浮层不该影响它。
		 */
		var SURFACE_KEYS = ["open", "drawer", "corner"];

		// ------------------------------------------- 呈现模式：`mode` 是单一真相（方案 B 第一期）
		//
		// 2026-09 t34：把上面那三个布尔**收敛成一个** `mode` + **一个** `appId`，三个旧键
		// （以及各自的 id）退化成**派生物** —— 兼容层，不是删掉：所有既有读法
		// （`ui.get().open` / `.drawer` / `.corner` / `.drawerId` / `.cornerId`）都照旧成立，
		// 写入口也照旧收旧键（`ui.set({ drawer: true, drawerId })`）。这样状态机与语义先立住，
		// 第二期（退役自绘路径、接到 DSH 原生 rightbar）才有一个唯一的真相可以改。
		//
		// **为什么 mode 是四个值而不是三个。** 今天这三个面是**互斥**的（`SURFACE_KEYS`
		// 那条判决：开一个就关掉另外两个），而"全屏面板"本身就是其中一个面 ——
		// 三个互斥面 + 一个"都没开" = **四个状态**。任务书写的 `hidden | docked | floating`
		// 只覆盖了两面（并列 / 悬浮）；少了 `panel` 这一档，`open` 就没法再由 mode 派生，
		// 于是"单一真相"立刻变成"两个真相"。所以这里取四值，并把映射写死成一张表：
		//
		//   mode            open    drawer   corner    说明
		//   ------------    -----   ------   ------    --------------------------------
		//   "hidden"        false   false    false     都没开（含"刚关掉"）
		//   "panel"         true    false    false     全屏面板（库页面 / 全屏运行页）
		//   "docked"        false   true     false     并列：右侧那一列（DSH 原生右栏）
		//   "floating"      false   false    true      悬浮：会话右上角浮窗（DSH 原生 float）
		//
		// `appId` 同理是**一个** id：它属于"当前正在画的那一面"（面板那一档不用它 ——
		// 面板靠一次性命令 `runningId` 决定跑哪一个）。派生的 `drawerId` / `cornerId`
		// 只在对应面开着时才带值 —— 旧实现里"关掉的那一面还留着上次的 id"，没有任何消费者
		// 读它（那个面的组件只在它开着时才渲染），这里顺手收敛掉。
		var PRESENTATION_MODES = Object.freeze(["hidden", "panel", "docked", "floating"]);

		/** 旧三键 → mode 的唯一映射（两个方向都由它推导，避免两处各写一份）。 */
		var MODE_OF_SURFACE = Object.freeze({ open: "panel", drawer: "docked", corner: "floating" });
		/** mode → 旧三键里"该亮"的那一个；hidden 一个都不亮。 */
		var SURFACE_OF_MODE = Object.freeze({ panel: "open", docked: "drawer", floating: "corner" });

		/**
		 * 「悬浮只能由停靠态转入」—— t31 / t33 实测出来的两条硬事实，写进这一个纯函数，
		 * 供第二期接 DSH 原生 rightbar 时使用（本期不调 `sidebarRight`，所以只建模、不接线）。
		 *
		 * 两条事实（都有代码证据，见 docs/research/rightbar-feasibility.zh-CN.md §8）：
		 *  ① `float(tabId, rect)` 里有一句硬前置 `if (findTabPane(layout, tabId).host !== "dock") return;`
		 *     ⇒ 不在停靠态时它**静默 return**（幂等）：从 hidden 直接求悬浮会得到一次
		 *     "看起来成功、其实什么都没发生"的调用。**悬浮的有效入口只有停靠态。**
		 *  ② `openTab` / `float` / `dock` **都没有返回值**（undefined）⇒ 不能把 undefined 当成功。
		 *     每一步都要**读回**（状态或几何）来判定，这个函数就是那个判定。
		 *
		 * `observed` 是调用方**读回**来的事实：`{ docked, floating }`。
		 * 返回 `{ ok, reason }`：ok=false 时调用方不得更新界面状态（尤其不得把 mode 写成 floating）。
		 */
		function presentationStep(action, observed) {
			var docked = observed !== null && observed !== undefined && observed.docked === true;
			var floating = observed !== null && observed !== undefined && observed.floating === true;
			if (action === "float") {
				// ①：不在停靠态就**不发**这次调用 —— 发了也是静默 return，只会让人以为成功了。
				if (!docked) return { ok: false, reason: "not-docked" };
				return { ok: true, reason: "floating" };
			}
			if (action === "dock") {
				if (!floating) return { ok: false, reason: "not-floating" };
				return { ok: true, reason: "docked" };
			}
			if (action === "open") {
				// 停靠是唯一入口：先停靠，再谈悬浮。
				return { ok: docked || floating, reason: docked || floating ? "present" : "not-present" };
			}
			return { ok: false, reason: "unknown-action" };
		}

		/**
		 * 把一次 `ui.set(patch)` 归一成新的 `{ mode, appId }`。
		 *
		 * 归一必须**逐字复刻**旧判决，否则"行为零变化"就是一句空话。旧算法是：
		 *   ① `next = {...state, ...patch}`；
		 *   ② 按 `SURFACE_KEYS` 顺序，对每个 `patch[k] === true` 的键，把**另外两个**写 false。
		 * 于是它的净效果等价于：
		 *   * patch 里有 `true` ⇒ **最后一个为 true 的键**胜出（顺序就是 SURFACE_KEYS），另外两个关掉；
		 *   * patch 里没有 `true` ⇒ 只把显式给成 `false` 的键写 false；若那个键正是当前亮着的面，
		 *     灯就熄了（hidden），否则什么都不变（关一个本来就没开的面不该影响别的）。
		 * `appId` 跟着"带 id 的那一面"走；两个 id 同时给时不猜（以 patch 里激活的那一面为准，
		 * 其次 corner —— 与 SURFACE_KEYS 的先后一致）。
		 */
		function nextPresentation(current, patch) {
			var activated = null;
			var trues = 0;
			for (var index = 0; index < SURFACE_KEYS.length; index += 1) {
				if (patch[SURFACE_KEYS[index]] === true) { activated = SURFACE_KEYS[index]; trues += 1; }
			}
			var mode = current.mode;
			if (trues >= 2) {
				// **有意改正（t37 的显式决策，不是继承怪癖）**：旧循环在"一次 patch 给两个 `true`"
				// 时的净结果是三个全 false（第一轮把后一个写成 false，后一轮只写别人、不会把自己
				// 写回 true）。那是个**没人依赖的意外**：真实调用点从不这么发（每一处都只给一个
				// `true`），而"后一个 `true` 胜出"是可预测的语义。所以这里改成后者，
				// 并由 `test/client.test.mjs` 里一条断言钉住新行为（旧行为在 t34 的 1344 次
				// 等价性探针里被证明是唯一的奇癖）。
				mode = MODE_OF_SURFACE[activated];
			} else if (activated !== null) {
				mode = MODE_OF_SURFACE[activated];
			} else {
				for (var index2 = 0; index2 < SURFACE_KEYS.length; index2 += 1) {
					var key = SURFACE_KEYS[index2];
					if (patch[key] === false && SURFACE_OF_MODE[mode] === key) mode = "hidden";
				}
			}
			// `appId` 只跟着**激活的那一面**（或当前正开着的那一面）走。这一条是被探针逼出来的：
			// 第一版规则是"patch 给了 id 就用它"，于是 `ui.set({cornerId:'C'})` 在**停靠态**
			// 下会把 `appId` 改成 `C` —— 派生出来的 `drawerId` 跟着变成 `C`，右侧栏会去画另一个
			// 小程序。真实调用点不会这么发（id 永远跟自己的面标志一起来），但状态机不该靠
			// "调用方守规矩"来保正确：**给关闭着的那一面的 id，一律不采纳**（旧实现把它存在
			// 那里当垃圾字段，没有任何消费者读 —— 见上面那段"派生物"注释）。
			var appId = current.appId;
			var hasDrawerId = patch.drawerId !== undefined;
			var hasCornerId = patch.cornerId !== undefined;
			var drawerTargets = activated === "drawer" || mode === "docked";
			var cornerTargets = activated === "corner" || mode === "floating";
			if (hasDrawerId && drawerTargets && !(hasCornerId && cornerTargets)) appId = patch.drawerId;
			else if (hasCornerId && cornerTargets) appId = patch.cornerId;
			return { mode: mode, appId: appId };
		}

		/** 由 `{ mode, appId }` 算出全部旧键 —— 派生物只在这一处生成。 */
		function deriveLegacySurfaces(presentation, appId) {
			return {
				open: presentation === "panel",
				drawer: presentation === "docked",
				corner: presentation === "floating",
				drawerId: presentation === "docked" ? appId : null,
				cornerId: presentation === "floating" ? appId : null
			};
		}

		// ------------------------------------------------------ 五个「跑的地方」
		//
		// 同一个小程序有五个能跑的地方，用户站在其中任何一个里，都要能**一下就切到
		// 别的任何一个**，而不是退回全屏面板重来。这张表就是那五枚按钮的唯一来源：
		// 顺序（界面顺序 = 数组顺序）、图标、文案键，以及"点下去做什么"（switchLayout）。
		//
		// 为什么是一张模块级数组而不是五处各写一遍：五枚按钮的**顺序**、"每一枚都有
		// 名字与图标"、"当前那一枚要高亮"这三件事都必须是可遍历、可断言的事实 ——
		// 散在四处的 JSX 里就只能靠肉眼看。这也正是 `SURFACE_KEYS` 的做法。
		//
		// 与 SURFACE_KEYS 的关系：前三个（面板 / 右侧栏 / 悬浮）各对应一个互斥的
		// "**跑在哪儿**"，用户切过去时由 `createUiState().set` 顺手关掉另外两个；
		// 后两个不是浮层 —— 会话页签是会话主体的一部分，浏览器新页签干脆在 DSH 之外。
		//
		// 2026-09：后三个键的**画法**都换过地基（右栏与悬浮交给 DSH 原生能力），
		// 但**这五个地方没有变**，所以这张表与那排按钮一字未动 —— 它记的是产品上
		// "能跑到哪里去"，不是"谁负责画"。谁负责画写在 switchLayout 里。
		var LAYOUT_PLACES = [
			{ key: "panel", icon: "panel", labelKey: "layout.place.panel" },
			{ key: "drawer", icon: "side", labelKey: "layout.place.drawer" },
			{ key: "session", icon: "tab", labelKey: "layout.place.session" },
			{ key: "corner", icon: "corner", labelKey: "layout.place.corner" },
			{ key: "browser", icon: "browser", labelKey: "layout.place.browser" }
		];

		/**
		 * 切换按钮的边长与缝宽。
		 *
		 * 26 而不是工具栏那套 32：五枚连着排要挤进**原生右栏那一格**（那一列本来就不宽，
		 * 右边还留着关闭与名字），26×26 是"点得到"与"排得下"之间的那个数；图标 14px 与
		 * `corner` 那一档的 16px 图标同族，缩一档正好。
		 */
		var LAYOUT_SWITCH_SIZE = 26;
		var LAYOUT_SWITCH_GAP = 2;

		/**
		 * 切换控件自身的固有宽度：五枚按钮 + 四个缝。
		 *
		 * 它仍然是给**头部那一行**算账用的纯函数：每个运行面的头都要同时装下图标（24）、
		 * 名字、这个控件与关闭（32），名字那一格还得剩得下人话。把它抽成函数，那笔账
		 * 才能在单测里被算一遍，而不是等真机上头部挤成一条缝才发现。
		 *
		 * 2026-09：那段"380px 是浮窗给的"没有了（自绘浮窗退役），但这个数与它服务的
		 * 那排按钮**都还在** —— 四个运行面的头画的仍是同一排，所以账照算。
		 */
		function layoutSwitcherWidth() {
			return LAYOUT_PLACES.length * LAYOUT_SWITCH_SIZE + (LAYOUT_PLACES.length - 1) * LAYOUT_SWITCH_GAP;
		}

		/** 按 key 取一个「地方」；不认识返回 null（调用方据此拒绝，而不是当没发生过）。 */
		function findLayoutPlace(key) {
			for (var index = 0; index < LAYOUT_PLACES.length; index += 1) {
				if (LAYOUT_PLACES[index].key === key) return LAYOUT_PLACES[index];
			}
			return null;
		}

		function createUiState() {
			// settingsInjected：设置栏注入是否已经成功。注入成功时兜底座位的按钮让位。
			//
			// **单一真相**：`mode`（presentation）+ `appId` —— 见上面那张映射表。
			// `open` / `drawer` / `corner` / `drawerId` / `cornerId` 是**派生物**，每次 `set`
			// 由 `deriveLegacySurfaces` 重算一遍并**存在同一份对象上**：这样 `get()` 仍然返回
			// 一个**稳定引用**（React 侧 `useState(ui.get())` + 订阅比较的是同一个对象），
			// 既有的读法一个都不需要改。
			//
			// toast 是**三个浮层都关着时也要能显示的一句话**：「已放到本会话页签」那条
			// 必须活在浮层关闭之后，否则用户根本看不到它。
			var state = Object.assign({
				mode: "hidden",
				appId: null,
				runningId: null,
				toast: null,
				settingsInjected: false
				// 这里原来还有两个键：`cornerPosition` / `cornerSize` —— 用户自己摆过的
				// 浮窗位置与尺寸（`null` = 还没被拖过）。自绘浮窗退役后**它们没有消费者**了：
				// 拖动、夹取、复位全部随 `MiniAppFloatingRunner` 一起删掉，悬浮交给 DSH，
				// 位置由它自己记。留着会是两个谁都不读的字段，还会让"ui 里存着什么"
				// 与"谁在画窗口"对不上。
			}, deriveLegacySurfaces("hidden", null));
			var listeners = new Set();
			return {
				get: function () { return state; },
				set: function (patch) {
					var next = Object.assign({}, state, patch);
					// 互斥判决与派生：只在这一处做。`nextPresentation` 复刻的是旧判决
					// （最后一个 true 胜出 / 显式 false 只能熄掉自己那一盏灯），
					// 于是"开一个顺手关掉另外两个"这条对调用方的承诺一字未改。
					var presentation = nextPresentation(state, patch);
					Object.assign(next, deriveLegacySurfaces(presentation.mode, presentation.appId), presentation);
					state = next;
					listeners.forEach(function (listener) { listener(); });
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				}
			};
		}

		// ------------------------------------------------------------ 网络与工具

		/** 调宿主半边的 JSON 接口，非 2xx 时抛出带后端消息的错误。 */
		async function callApi(path, options) {
			var init = Object.assign({ credentials: "same-origin", headers: {} }, options || {});
			if (init.body !== undefined) {
				init.headers = Object.assign({ "content-type": "application/json" }, init.headers);
				init.body = JSON.stringify(init.body);
			}
			var response = await fetch(API + path, init);
			var payload = await response.json().catch(function () { return undefined; });
			if (!response.ok || !payload || payload.ok !== true) {
				var message = (payload && payload.error) || ("HTTP " + response.status);
				var error = new Error(message);
				error.payload = payload;
				error.status = response.status;
				throw error;
			}
			return payload.data;
		}

		/** 相对时间：与 NomiFun 原版的文案档位保持一致。 */
		function relativeTime(t, ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
			var delta = Date.now() - ms;
			if (delta < 60 * 1000) return t("time.justNow");
			var minutes = Math.floor(delta / (60 * 1000));
			if (minutes < 60) return t("time.minutesAgo", { count: minutes });
			var hours = Math.floor(minutes / 60);
			if (hours < 24) return t("time.hoursAgo", { count: hours });
			var days = Math.floor(hours / 24);
			if (days === 1) return t("time.yesterday");
			if (days < 7) return t("time.daysAgo", { count: days });
			return t("time.weeksAgo");
		}

		function formatBytes(value) {
			if (!Number.isFinite(value) || value <= 0) return "0 B";
			if (value < 1024) return value + " B";
			if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
			return (value / (1024 * 1024)).toFixed(1) + " MB";
		}

		// -------------------------------------------------- 小程序目录（三处共用）
		//
		// 库页面、会话页签、右侧栏那一格、悬浮那一面都只需要同一份东西：「已发布的小程序」列表。
		// 目录放在模块级而不是各自的 useState 里，有两个具体理由：
		//
		//  1. 右栏那一格与悬浮面是"打开即用"的：它们只有一次渲染机会，等不到"先渲染一次、effect
		//     里再拉一次"的那种两段式；本地状态在那一刻永远是空的，于是会先闪一个空壳。
		//  2. 会话页签与浮层可以同时开着（页签不是浮层，不受互斥约束），各拉一次 /apps
		//     就是同一份数据的两次请求 —— 而它们显示的必须是同一个列表。
		//
		// 快照不可变（与 MiniAppModeStore 同构），所以订阅者可以放心按引用比较。

		function MiniAppCatalog() {
			this.state = { apps: [], loading: false, error: null, loaded: false };
			this.listeners = new Set();
			this.inflight = null;
		}

		MiniAppCatalog.prototype.get = function () {
			return this.state;
		};

		MiniAppCatalog.prototype.subscribe = function (listener) {
			this.listeners.add(listener);
			var self = this;
			return function () { self.listeners.delete(listener); };
		};

		MiniAppCatalog.prototype.set = function (patch) {
			this.state = Object.assign({}, this.state, patch);
			this.listeners.forEach(function (listener) { listener(); });
		};

		/**
		 * 拉一次列表。多个读者同时要时共用同一个在飞的请求（`inflight`），
		 * 已经拉过又没要求强制刷新时直接返回 —— 于是切页签不会每次都打一次后端。
		 */
		MiniAppCatalog.prototype.load = function (force) {
			var self = this;
			if (this.inflight !== null) return this.inflight;
			if (this.state.loaded === true && force !== true) return Promise.resolve(this.state.apps);
			this.set({ loading: true, error: null });
			this.inflight = callApi("/apps").then(function (list) {
				self.inflight = null;
				var apps = Array.isArray(list) ? list : [];
				self.set({ apps: apps, loading: false, error: null, loaded: true });
				return apps;
			}, function (error) {
				self.inflight = null;
				// 失败不清空已有列表：目录里剩下的那几条仍然可用，报错另行说明。
				self.set({ loading: false, error: describeError(error) });
				return [];
			});
			return this.inflight;
		};

		/** 模块级的那一份。apply 里注册的每个面都读它。 */
		var appCatalog = new MiniAppCatalog();

		/**
		 * 跨座位状态也放在**模块级**，理由与 appCatalog 相同：`MiniAppRightbarPane`
		 * 是一个不接 ctx 的组件（它要能被 `sidebar.right.pane.tab` 那一格直接渲染），
		 * 而"哪一个面开着、跑的是哪一个 id"必须与页签 / 面板 / 右栏读到的是**同一份**
		 * —— 用户切来切去时不能各自拿着一份不同的记忆。
		 *
		 * 2026-09：这里原来还写"浮窗的位置与尺寸……用户拖过的位置要活得更久"。
		 * 那件事**没有了**：自绘浮窗退役之后位置由 DSH 自己记，`ui` 上那两个几何键
		 * （`cornerPosition` / `cornerSize`）也一起删了。
		 *
		 * `apply()` 里不再新建一份：那样渲染层读到的和组件写进去的会是两个对象。
		 */
		var ui = createUiState();

		/** 客户端预置进输入框的那句话，必须与宿主半边的 CREATE_MINIAPP_DRAFT 逐字一致。 */
		var CREATE_DRAFT = "/create-miniapp ";
		/** 技能名，同样与宿主半边的 CREATE_MINIAPP_SKILL.name 逐字一致（测试钉住这一条）。 */
		var CREATE_SKILL_NAME = "create-miniapp";

		/**
		 * 「创建小程序」的一次性意图：**先置位、再换会话、由新到的输入框消费**。
		 *
		 * 为什么需要它（而不是"开了新会话再把草稿写进去"）：`uiWorkspace.startSession()`
		 * 的签名是 `startSession(workspaceId?: WorkspaceId): void` —— 它**不返回**会话 id；
		 * 而且它可能**复用**当前这个空白会话（同工作区的 `connectWorkspace`：已经有一个
		 * 空白会话就直接返回它的 id），所以"等一个新 id 出现再写"这个判据根本不成立。
		 *
		 * 有先例可抄：DSH 自己的 `@deepseek-ai/dsh-client-ui-agent-preset` 的
		 * `creatorDraft` 就是 `seat.stage("cordis", true); scope.uiWorkspace.startSession();`
		 * —— **先 stage，再开新会话**，由新会话上挂着的座位消费（`lib/client.js:1467-1470`）。
		 *
		 * `claim()` 是"读并清"而不是分成 peek / clear 两步：两个空白会话同时挂着时
		 * 只有一个能拿到这次意图，而且同一帧里的重复渲染也不会把同一句话写第二遍。
		 *
		 * 没有消费者时它**不自己过期**：停在"当前没有会话/没有工作区"那种 shell 里点了
		 * 创建，意图会一直留着，直到下一个空白会话出现才落地。这是**有意**的 —— 用户按下
		 * 那颗按钮的意图就是"我要建一个"，把它悄悄丢掉才是骗人；而多写的也只是一句
		 * 可编辑的草稿，不是一次发送。
		 */
		function MiniAppCreateIntent() {
			this.pending = false;
			this.listeners = new Set();
		}

		MiniAppCreateIntent.prototype.isStaged = function () {
			return this.pending === true;
		};

		/** 置位并通知订阅者：消费者可能**已经挂载**（空白会话复用那条路），不会重新挂载。 */
		MiniAppCreateIntent.prototype.stage = function () {
			if (this.pending === true) return;
			this.pending = true;
			var self = this;
			this.listeners.forEach(function (listener) { listener(self.pending); });
		};

		/** 读并清：返回 true 表示"这次意图归你了"，同一份意图永远只会有一个 true。 */
		MiniAppCreateIntent.prototype.claim = function () {
			if (this.pending !== true) return false;
			this.pending = false;
			var self = this;
			this.listeners.forEach(function (listener) { listener(self.pending); });
			return true;
		};

		MiniAppCreateIntent.prototype.subscribe = function (listener) {
			this.listeners.add(listener);
			var self = this;
			return function () { self.listeners.delete(listener); };
		};

		/** 模块级那一份：库视图（置位）与 composer 座位（消费）分处两个组件树。 */
		var createIntent = new MiniAppCreateIntent();

		/**
		 * 在一份目录快照里按 id 找一条小程序；找不到返回 null。
		 *
		 * 组件拿到的是**快照**（`useCatalog()` 的返回值）而不是目录实例本身 ——
		 * 于是"把 appId 变成一条记录"这件事必须是一个纯函数，快照一换结果就跟着换。
		 */
		function findCatalogApp(catalog, appId) {
			if (catalog === null || catalog === undefined || typeof appId !== "string" || appId === "") return null;
			var apps = catalog.apps;
			for (var index = 0; index < apps.length; index += 1) {
				var app = apps[index];
				if (app !== null && typeof app === "object" && app.miniapp_id === appId) return app;
			}
			return null;
		}

		// ------------------------------------------ 固定的小程序（走宿主持久化）
		//
		// 「固定了哪个小程序」是**用户摆过的东西**：刷新页面、重启 DSH 都不该丢。
		//
		// **为什么走宿主，而不是 localStorage**：客户端半边没有任何可靠的持久化 API。
		// localStorage 不是 DSH 的插件契约 —— 它可能被浏览器策略禁掉、可能按来源分区、
		// 在无痕窗口里直接抛错，而 DSH 的 Web 端口每次启动都可能换一个（来源一变，
		// 存下来的东西就整片看不见了）。而插件本来就有一条通向宿主的 HTTP 通道
		// （`API_PREFIX`），宿主本来也有一份 `dataDir` —— 于是这条选择与小程序库共用
		// 同一处落点：`{dataDir}/prefs.json`。它在重启之后一定还在，就和小程序本身一样。
		//
		// 它**不进 `ui`**：`ui` 里那几个键回答的是"这一次会话在看哪个面"，关掉浮层就该忘掉；
		// 固定是跨会话、跨刷新的选择，住在磁盘上。

		function MiniAppPrefs() {
			this.state = { pinnedAppId: null, loaded: false, error: null };
			this.listeners = new Set();
			this.inflight = null;
		}

		MiniAppPrefs.prototype.get = function () {
			return this.state;
		};

		MiniAppPrefs.prototype.subscribe = function (listener) {
			this.listeners.add(listener);
			var self = this;
			return function () { self.listeners.delete(listener); };
		};

		MiniAppPrefs.prototype.set = function (patch) {
			this.state = Object.assign({}, this.state, patch);
			this.listeners.forEach(function (listener) { listener(); });
		};

		/** 从 `/prefs` 的响应里取固定值；形状不对一律当作"没有固定"。 */
		function readPinnedId(data) {
			if (data === null || data === undefined || typeof data !== "object") return null;
			var value = data.pinned_app_id;
			return typeof value === "string" && value !== "" ? value : null;
		}

		/**
		 * 点一次 📌 之后应该固定成谁 —— 同时只有一个固定，所以这是"三选一"的全部判决：
		 *
		 *  * `appId` 就是**当前固定的那一个** → 取消固定，返回 `null`；
		 *  * `appId` 是**别的另一个** → 顶掉旧的，返回它；
		 *  * 什么都没固定 → 固定成它。
		 *
		 * 抽成纯函数而不是写在 `pin` 里：这条判决是"再点一次会怎样"的全部答案，
		 * 而它错了的表现（点一次固定、再点一次没取消、或者固定了两个）只有真的点两遍才看得出来。
		 *
		 * 两个容错：
		 *  * `previous` 是坏的（`undefined` / 空串 / 不是字符串）一律归成 `null`：
		 *    磁盘上一条脏数据不该被当成"固定了一个叫 undefined 的小程序"；
		 *  * `appId` 是坏的（不是字符串、或空串）**不动**当前那一个 ——
		 *    一个认不出来的 id 不该被理解成"取消固定"。
		 */
		function pinAfterToggle(previous, appId) {
			var current = typeof previous === "string" && previous !== "" ? previous : null;
			if (typeof appId !== "string" || appId === "") return current;
			return current === appId ? null : appId;
		}

		/**
		 * 读一次。
		 *
		 * 失败**不弹错**，只是当成"没有固定"：它影响的只有标题栏下拉面板里
		 * 那一行说的是哪一条，没有任何理由为它弹一条错误、更没有理由挡住会话头部。`loaded` 照样置真 ——
		 * 否则一次失败会让"没读到过"永远成立，每次渲染都重打一次后端。
		 */
		MiniAppPrefs.prototype.load = function (force) {
			var self = this;
			if (this.inflight !== null) return this.inflight;
			if (this.state.loaded === true && force !== true) return Promise.resolve(this.state);
			this.inflight = callApi("/prefs").then(function (data) {
				self.inflight = null;
				self.set({ pinnedAppId: readPinnedId(data), loaded: true, error: null });
				return self.state;
			}, function (error) {
				self.inflight = null;
				self.set({ loaded: true, error: describeError(error) });
				return self.state;
			});
			return this.inflight;
		};

		/**
		 * 固定 / 取消固定。
		 *
		 * **先改本地、再写盘**（乐观更新）：那颗图标必须跟着手指走。等一个往返才变化，
		 * 用户会以为没点上、再点一次 —— 而第二次点击正好把它取消了。
		 * 写盘失败时**回滚**到点之前那一份，并把原因留在 `state.error` 上（不抛）。
		 */
		MiniAppPrefs.prototype.pin = function (appId) {
			var self = this;
			var previous = this.state.pinnedAppId;
			var next = pinAfterToggle(previous, appId);
			this.set({ pinnedAppId: next, error: null });
			return callApi("/prefs", { method: "POST", body: { pinned_app_id: next } }).then(function () {
				return self.state;
			}, function (error) {
				self.set({ pinnedAppId: previous, error: describeError(error) });
				return self.state;
			});
		};

		/** 模块级那一份。标题栏那一栏与测试读的是同一个。 */
		var prefs = new MiniAppPrefs();

		function usePrefs() {
			var [state, setState] = useState(prefs.get());
			useEffect(function () {
				setState(prefs.get());
				void prefs.load();
				return prefs.subscribe(function () { setState(prefs.get()); });
			}, []);
			return state;
		}

		// ------------------------------------------------- 会话页签的选中态
		//
		// 「这个会话选了哪个小程序」是**会话的属性**，不是全局开关 —— 与 MiniAppModeStore
		// 同构：`Map<sessionId, state>` + `Map<sessionId, listeners>`，快照不可变。
		//
		// 刻意不用 localStorage：这是个"这一眼在看什么"的临时选择，不该跨会话残留，
		// 也不该在刷新之后把用户拽回一个小程序里。

		/** 没被碰过的会话拿到的初始快照；引用必须是稳定的。 */
		var EMPTY_SESSION_VIEW = { appId: null };

		function MiniAppSessionStore() {
			this.states = new Map();
			this.listeners = new Map();
		}

		MiniAppSessionStore.prototype.snapshot = function (sessionId) {
			var state = this.states.get(sessionId);
			return state === undefined ? EMPTY_SESSION_VIEW : state;
		};

		MiniAppSessionStore.prototype.subscribe = function (sessionId, listener) {
			var listeners = this.listeners.get(sessionId);
			if (listeners === undefined) {
				listeners = new Set();
				this.listeners.set(sessionId, listeners);
			}
			listeners.add(listener);
			var self = this;
			return function () {
				listeners.delete(listener);
				if (listeners.size === 0) self.listeners.delete(sessionId);
			};
		};

		MiniAppSessionStore.prototype.update = function (sessionId, transform) {
			var current = this.snapshot(sessionId);
			var next = transform(current);
			// 快照没换就不通知：`open` / `close` 遇到"已经是这个值"时返回的还是那一份，
			// 而订阅者（页签的身体）每次被叫醒都要重渲染一遍 —— 一次多余的通知就是
			// 一次把一个正在跑的小程序 iframe 白重挂的风险。
			if (next === current) return;
			this.states.set(sessionId, next);
			var listeners = this.listeners.get(sessionId);
			if (listeners !== undefined) {
				listeners.forEach(function (listener) { listener(); });
			}
		};

		/** 在这个会话的页签里跑某一个小程序。 */
		MiniAppSessionStore.prototype.open = function (sessionId, appId) {
			if (typeof appId !== "string" || appId === "") return;
			this.update(sessionId, function (current) {
				return current.appId === appId ? current : { appId: appId };
			});
		};

		/** 回到空态（不离开页签，只是把这一格里的小程序放掉）。 */
		MiniAppSessionStore.prototype.close = function (sessionId) {
			this.update(sessionId, function (current) {
				return current.appId === null ? current : { appId: null };
			});
		};

		/**
		 * 还有没有**任何**会话在页签里放着小程序。
		 *
		 * 页签的注册是全局的（DSH 那一个 `conversation.view` 座位不分会话），
		 * 但"要不要显示这个页签"是按"有没有人用它"来决定的 —— 于是默认不显示，
		 * 用完最后一个就消失。
		 */
		MiniAppSessionStore.prototype.hasAny = function () {
			var found = false;
			this.states.forEach(function (state) {
				if (state !== null && state !== undefined && state.appId !== null) found = true;
			});
			return found;
		};

		/** 模块级那一份：`openInSession`（模块级函数）与页签组件共用同一个。 */
		var sessionViewStore = new MiniAppSessionStore();

		// ------------------------------------------------------ 切会话页签
		//
		// 页签按钮由 DSH 自己画（`slots.entries("conversation.view")` → 它自己的
		// `role="tab"` 按钮），我们只登记一格。要"从别处"把它切成激活，只有一条路：
		// `uiConversation` 这个 **DSH 内部服务**。
		//
		// 为什么不能拿到更"正当"的入口：激活态由 ui-conversation 自己的会话 store
		// 决定，而写入它的动作面（`selectView` / `openView`）挂在 `conversation.session`
		// 与 `conversation.session.header` 两个座位的 ownerProps 上 —— 前者被会话主体
		// 占着、后者渲染时给的是**空 props**，插件都拿不到。`uiConversation.binding(id)
		// .activate(view)` 正是 ui-conversation 自己 `activateView` 的落点，是唯一可用的口。
		//
		// 它是内部服务，所以**必须有"有就用、没有就降级"的写法**：拿不到就返回 false，
		// 由调用方明说"点上方页签切过去"，绝不静默失败。
		//
		// 会话 id 同样只能这么取：`sessions.list.getSnapshot().current`（ui-conversation
		// 内部读的也是这个字段）。`ctx.get` 是可选依赖的正确读法 —— 这两个服务都**不该**
		// 进 inject 列表，否则更老的 DSH 上整个客户端半边会被挂起等待。
		/**
		 * 当前会话 id；拿不到返回 null（而不是 undefined，方便调用方判空）。
		 */
		function currentSessionId(ctx) {
			try {
				if (ctx === undefined || ctx === null || typeof ctx.get !== "function") return null;
				var sessions = ctx.get("sessions");
				if (sessions === undefined || sessions === null) return null;
				var snapshot = sessions.list.getSnapshot();
				var id = snapshot === undefined || snapshot === null ? undefined : snapshot.current;
				return typeof id === "string" && id !== "" ? id : null;
			} catch (error) {
				return null;
			}
		}

		/**
		 * 找会话头部那一排页签里属于我们的那一颗。
		 *
		 * **为什么靠文字找**：DSH 渲染页签按钮时（`role="tab"`）身上**没有任何 data-* 标识**，
		 * 源码里就是 `<button role="tab" aria-selected={…} onClick={() => selectView(id)}>{label}</button>`。
		 * 所以唯一稳定的抓手是它显示的文字 —— 也就是我们自己登记的那个 label。
		 * 顺带排掉我们自己的面板（它也有 `role="tablist"`，但那几颗是分类 tab）。
		 */
		function findSessionViewTab(tabLabel) {
			if (typeof document === "undefined" || typeof tabLabel !== "string" || tabLabel === "") return null;
			var tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
			for (var index = 0; index < tabs.length; index += 1) {
				var node = tabs[index];
				if (typeof node.closest === "function" && node.closest("[data-dsh-miniapp-panel]") !== null) continue;
				if ((node.textContent || "").trim() === tabLabel) return node;
			}
			return null;
		}

		/**
		 * 把会话切到我们的页签。
		 *
		 * **这不是"劫持 DSH 的 UI"，而是用户那句指令的直接兑现** —— 用户点的是
		 * 「在本会话页签打开」，替他点一下那一颗页签正是他要的结果。
		 *
		 * 为什么不能走"更干净"的路（都实测过）：
		 *  * 页签的高亮与身体都取自会话 store 的 `view` 字段，而写它的只有 `setView` / `openView`；
		 *  * 这两个只从 `conversation.session.header` 的 `selectView` 与 `conversation.session`
		 *    的 `openView` 进入 —— 前者渲染子座位时给的是**空 props**，后者被会话主体占着，
		 *    插件都拿不到；
		 *  * 内部服务那条（`uiConversation.binding(id).activate(view)`）落到
		 *    `ConversationNodeAssembler.activateTarget()`，而它只在
		 *    `this.views.get(target)` **注册过快照 builder** 时才 `replaceView`：
		 *    chat / trajectory 各自注册过，我们没有 —— 所以它只是往 `activeTargets` 里加个
		 *    名字就返回，页签既不高亮也不换身体（而且不报错）。给一个没注册过的 target 调
		 *    内部接口本身也是一种副作用，所以这里**不调它**。
		 *
		 * 页签自己的 onClick 走的是 DSH 的 `selectView` → `actions.setView`，那才是真的。
		 *
		 * @returns 我们的页签现在是不是当前页签。false 表示**页签根本不在**（空白会话的
		 *          头部是隐藏的、或者这个 DSH 改了页签 DOM），调用方必须把这件事说出来。
		 */
		function focusSessionViewTab(tabLabel) {
			var tab = findSessionViewTab(tabLabel);
			if (tab === null) return false;
			// 已经在我们的页签上就别再点（点击会触发一次没必要的 store 写入）。
			if (tab.getAttribute("aria-selected") === "true") return true;
			if (typeof tab.click !== "function") return false;
			tab.click();
			// 不能在这里回读 aria-selected：React 的 store 更新是异步的，点完立刻读一定是旧值。
			// 点下去了就算做到位了 —— 页签那一颗的 onClick 是我们唯一能触达的写入口。
			return true;
		}

		// ------------------------------------------------- 右侧栏（按需接管 details）

		/**
		 * 真正的右侧栏 —— 就是 DSH 布局里那一列（`details` 座位）。
		 *
		 * DSH 的那一列被 `dsh-client-ui-chat` 的 `DetailsPanel` 占着（工具详情在里面），
		 * 座位的契约也写明了 "registering here replaces the column and takes that seat
		 * with it"。所以这里**不是**另开一列（布局里没有第二列可开），而是
		 * **按需接管、关掉时归还**：
		 *
		 *   * 用户点「在右侧打开」→ 注册进 `details`（盖住 DetailsPanel）→
		 *     `ctx.layout.openDetails()` 让布局把这一列打开；
		 *   * 用户关掉 → 撤销注册（DetailsPanel 自己回来）→ `ctx.layout.closeDetails()`。
		 *
		 * 代价是明确的、也是可逆的：**这一列被我们占着的期间，工具详情看不到**。
		 * 因为 `details` 是 `single`，一列只能有一个主人 —— 这不是取舍，是布局的事实。
		 * 关掉小程序右侧栏，工具详情立刻回来。
		 *
		 * 它和"抽屉"那种浮层的区别就在 `position`：这一版由布局安排宽度，打开时
		 * **会话区会被挤窄**；浮层是盖在会话上面的。
		 */
		// ------------------------------- DSH 原生右栏：接线（方案 B 第一期，旧路径暂留降级）
		//
		// 这一期只做一件事：**把原生那套接上、并被断言住**；`details` 与自绘几何继续当降级路径
		//（第二期退役它们）。形状由两条**实测**事实决定（t31/t33，见
		// `docs/research/rightbar-feasibility.zh-CN.md` §8）：
		//
		//   ① `openTab` / `float` / `dock` / `toggleExpanded` **都没有返回值**（undefined）
		//      ⇒ 每一步都要**读回**（状态或几何）才算成功；`undefined` 永远不当成功。
		//   ② `float(tabId, rect)` 里有一句硬前置 `host !== "dock"` 时**静默 return**
		//      ⇒ 悬浮**只能由停靠态转入**（`presentationStep` 已经把这条写成判定）。
		//
		// 两个服务都是**可选依赖**：老 DSH 上没有它们，`ctx.get` 给 undefined —— 那种情况一律
		// 返回“没做成”（绝不假装成功），由调用方决定降级。**这也是它必须能被断言的原因**：
		// “没有服务时不自称成功”正是最容易写漏、也最难肉眼发现的那一半。

		/** 取一个可选服务：拿不到返回 null（不抛、不静默造一个假的）。 */
		function serviceOf(ctx, name) {
			if (ctx === undefined || ctx === null || typeof ctx.get !== "function") return null;
			var service = null;
			try {
				service = ctx.get(name);
			} catch (error) {
				return null;
			}
			return service === undefined || service === null ? null : service;
		}

		function rightbarService(ctx) { return serviceOf(ctx, "sidebarRight"); }
		function rightbarTabsService(ctx) { return serviceOf(ctx, "sidebarRightTabs"); }

		/**
		 * 读回 DSH 右栏的**现状**——这是"成功"的唯一判据。
		 *
		 * 形状是**容错**的（`active()` 返回 tab 对象还是 id、浮起状态挂在 `host` 还是 `floating`，
		 * t31/t33 都没有把形状钉死），读不到的一律记 `null` = **未知**，而未知在
		 * `presentationStep` 里不会被当成成功。宁可漏报成功，也不假报成功。
		 */
		function observeRightbar(sidebarRight) {
			var unknown = { docked: null, floating: null, expanded: null, activeId: null };
			if (sidebarRight === null) return unknown;
			var active = null;
			try {
				if (typeof sidebarRight.active === "function") active = sidebarRight.active();
			} catch (error) {
				active = null;
			}
			var activeId = null;
			if (typeof active === "string") activeId = active;
			else if (active !== null && typeof active === "object") {
				if (typeof active.id === "string") activeId = active.id;
				else if (typeof active.tabId === "string") activeId = active.tabId;
			}
			var expanded = null;
			try {
				if (typeof sidebarRight.isExpanded === "function") {
					var read = sidebarRight.isExpanded();
					if (typeof read === "boolean") expanded = read;
				}
			} catch (error) {
				expanded = null;
			}
			// "停靠" = 活动 tab 就是我们的那一个。读不到 id 就是**未知**（null），不是 false。
			var docked = activeId === null ? null : activeId === RIGHTBAR_VIEW_ID;
			// "浮起"：只有读得到 host / floating 才判；读不到 = 未知。
			var floating = null;
			if (active !== null && typeof active === "object") {
				if (typeof active.floating === "boolean") floating = active.floating;
				else if (typeof active.host === "string") floating = active.host === "float";
			}
			return { docked: docked, floating: floating, expanded: expanded, activeId: activeId };
		}

		/** 把我们的 tab 开到停靠位（`openTab` 首参是 **kind**，不是 id）。 */
		function openRightbarPane(ctx) {
			var sidebarRight = rightbarService(ctx);
			if (sidebarRight === null || typeof sidebarRight.openTab !== "function") {
				return { ok: false, reason: "no-service", observed: null };
			}
			try {
				sidebarRight.openTab(RIGHTBAR_VIEW_KIND);
			} catch (error) {
				return { ok: false, reason: "threw", observed: null };
			}
			var observed = observeRightbar(sidebarRight);
			var step = presentationStep("open", observed);
			return { ok: step.ok, reason: step.reason, observed: observed };
		}

		/**
		 * 把我们的 tab 从**停靠态**浮起来。
		 *
		 * 先读一次：不在停靠态就**不发**这次调用（发了也是静默 return，只会让人以为成功了）；
		 * 发完再读一次，只有读回"浮起了"才算成功。`rect` 由调用方给（t33 实测：给了就用给的，
		 * 只在 undefined 时落默认）。
		 */
		function floatRightbarPane(ctx, rect) {
			var sidebarRight = rightbarService(ctx);
			if (sidebarRight === null || typeof sidebarRight.float !== "function") {
				return { ok: false, reason: "no-service", observed: null };
			}
			var before = observeRightbar(sidebarRight);
			var gate = presentationStep("float", before);
			if (!gate.ok) return { ok: false, reason: gate.reason, observed: before };
			try {
				if (rect === undefined) sidebarRight.float(RIGHTBAR_VIEW_ID);
				else sidebarRight.float(RIGHTBAR_VIEW_ID, rect);
			} catch (error) {
				return { ok: false, reason: "threw", observed: before };
			}
			var after = observeRightbar(sidebarRight);
			// 读回必须真的看到"浮起"。读不到（null）不算成功 —— 这正是"不能把 undefined 当成功"。
			if (after.floating !== true) return { ok: false, reason: "not-observed", observed: after };
			return { ok: true, reason: "floating", observed: after };
		}

		/**
		 * 把浮起的那一格放回停靠位。
		 *
		 * `dock(paneId)` 要的是**停靠格 id**，而那个 id 我们**没有**（我们只知道自己的 tab id）
		 * —— 所以它必须由调用方从读回里拿来。拿不到就返回"没做成"，**不去猜一个 id**。
		 */
		function dockRightbarPane(ctx, paneId) {
			var sidebarRight = rightbarService(ctx);
			if (sidebarRight === null || typeof sidebarRight.dock !== "function") {
				return { ok: false, reason: "no-service", observed: null };
			}
			if (typeof paneId !== "string" || paneId === "") {
				return { ok: false, reason: "no-pane-id", observed: observeRightbar(sidebarRight) };
			}
			var before = observeRightbar(sidebarRight);
			var gate = presentationStep("dock", before);
			if (!gate.ok) return { ok: false, reason: gate.reason, observed: before };
			try {
				sidebarRight.dock(paneId);
			} catch (error) {
				return { ok: false, reason: "threw", observed: before };
			}
			var after = observeRightbar(sidebarRight);
			if (after.docked !== true) return { ok: false, reason: "not-observed", observed: after };
			return { ok: true, reason: "docked", observed: after };
		}

		/** 把我们那一格 tab 收回去（`close(tabId)`）；读回确认它真的不再活动。 */
		function closeRightbarPane(ctx) {
			var sidebarRight = rightbarService(ctx);
			if (sidebarRight === null || typeof sidebarRight.close !== "function") {
				return { ok: false, reason: "no-service", observed: null };
			}
			try {
				sidebarRight.close(RIGHTBAR_VIEW_ID);
			} catch (error) {
				return { ok: false, reason: "threw", observed: null };
			}
			var after = observeRightbar(sidebarRight);
			if (after.activeId !== null) return { ok: false, reason: "not-observed", observed: after };
			return { ok: true, reason: "closed", observed: after };
		}

		/**
		 * 展开 / 折叠右栏（DSH 自己的那个控件做的事，我们只是**代它按一下**）。
		 *
		 * 幂等：已经就是目标状态就直接回 ok（不动手）；否则 `toggleExpanded()` 之后再读回
		 * `isExpanded()`，只有读到目标值才算成功。
		 */
		function setRightbarPaneExpanded(ctx, expanded) {
			var sidebarRight = rightbarService(ctx);
			if (sidebarRight === null || typeof sidebarRight.toggleExpanded !== "function") {
				return { ok: false, reason: "no-service", observed: null };
			}
			var before = observeRightbar(sidebarRight);
			if (before.expanded === null) return { ok: false, reason: "unreadable", observed: before };
			if (before.expanded === expanded) return { ok: true, reason: "already", observed: before };
			try {
				sidebarRight.toggleExpanded();
			} catch (error) {
				return { ok: false, reason: "threw", observed: before };
			}
			var after = observeRightbar(sidebarRight);
			if (after.expanded !== expanded) return { ok: false, reason: "not-observed", observed: after };
			return { ok: true, reason: expanded ? "expanded" : "collapsed", observed: after };
		}

		// ------------------------------------------------- 会话页签的登记（按需）

		/**
		 * 页签登记的生命周期。
		 *
		 * **默认不注册。** DSH 的 `conversation.view` 是全局座位、不分会话 ——
		 * 一注册，每个会话的头部都会多出这一格。所以只在"真的有会话把它用起来"时才登记，
		 * 最后一个用它的会话也关掉之后，撤掉登记，页签自己就消失了。
		 *
		 * 由此得到的行为：刚打开 DSH 时头部只有「对话 / 轨迹」；点「在本会话页签打开」
		 * 才出现「小程序」；在页签里点「关闭」把它放空，若再没有别的会话用它，页签就没了。
		 *
		 * 已知的边界（写在 README 的已知限制里）：登记是全局的，所以 A、B 两个会话都放了
		 * 小程序时，在 A 关掉只会让 A 回到空态，页签仍为 B 留着。
		 */
		var viewTabRegistration = null;

		/** 现在需不需要这个页签：有任何会话在用它就要。 */
		function viewTabWanted() {
			return sessionViewStore.hasAny();
		}

		/** 按需登记；已经有登记时不重复登记。`registerViewTab` 由 `apply` 注入。 */
		function syncViewTab(ctx) {
			var wanted = viewTabWanted();
			if (wanted === false) {
				if (viewTabRegistration !== null) {
					viewTabRegistration();
					viewTabRegistration = null;
				}
				return;
			}
			if (viewTabRegistration !== null) return;
			if (typeof registerViewTab !== "function") return;
			viewTabRegistration = registerViewTab(ctx);
		}

		/** 真正调 `ctx.slots.inject` 的那一步；`apply` 里赋值，测试里也可以换成假的。 */
		var registerViewTab = null;

		/**
		 * 把一个小程序放进某个会话的页签，并把页签切过去。
		 *
		 * 顺序是有意的：**先注册页签、再写 store、最后切过去**。
		 *  * 注册必须排在切页签之前 —— 页签是 DSH 按登记项画出来的，没登记就没有可点的那一颗；
		 *  * 写 store 排在切页签之前，于是即使切页签那一步失败（页签不在），用户手动点一下
		 *    上方页签，看到的也已经是他刚才选的那一个，而不是一个空态。
		 *
		 * @returns 页签切过去了吗；false 只表示"没切过去"，选择本身已经生效。
		 */
		function openInSession(ctx, sessionId, appId, tabLabel) {
			if (typeof sessionId !== "string" || sessionId === "") return false;
			if (typeof appId !== "string" || appId === "") return false;
			sessionViewStore.open(sessionId, appId);
			syncViewTab(ctx);
			return focusSessionViewTab(tabLabel);
		}

		/**
		 * 关掉某个会话页签里的那一格；如果**再没有**会话放着小程序，就把页签整个撤掉。
		 *
		 * 这是"用完就不显示"的落点：DSH 会在登记项消失后自己把页签收掉，
		 * 如果当前正停在这一格上，`resolveActiveView` 会退回默认的「对话」。
		 */
		function closeInSession(ctx, sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return;
			sessionViewStore.close(sessionId);
			syncViewTab(ctx);
		}

		// ------------------------------------------------------ 切换布局
		//
		// 「同一个小程序，五个地方，站在任何一个里都能一下切到别处」这件事的**唯一落点**。
		// 四个头（全屏运行页、会话页签、原生右栏那一格、悬浮面）里那排按钮长得一样、干的事
		// 也一样，差别只有"我这一枚正是当前所在的那一个"；所以动作只写一遍，就是这里。

		/**
		 * 在新页签里打开运行页。
		 *
		 * 抽出来是为了**只有一处拼 URL**：切换控件里浏览器那一枚、看护条上那条降级入口，
		 * 走的是同一条 `src=SERVE/…`。
		 *
		 * @returns 真的叫了 `window.open` 吗。没有 `window.open`（测试的 vm、被裁剪的宿主）
		 *          时返回 false —— 静默是必然的（开新页签是浏览器的事），但调用方不该
		 *          以为它成功了。
		 */
		function openInBrowser(appId) {
			if (typeof appId !== "string" || appId === "") return false;
			if (typeof window === "undefined" || typeof window.open !== "function") return false;
			window.open(SERVE + "/" + encodeURIComponent(appId), "_blank", "noopener");
			return true;
		}

		/**
		 * 把一个小程序切到五个地方里的某一个。
		 *
		 * 前三个地方（面板 / 右侧栏 / 悬浮）只需要写自己那一个键：互斥是
		 * `createUiState().set` 里的判决，调用方**不必**自己去关别人。
		 *
		 * ⚠️ 但**能不能真的切过去**要读回确认：右栏与悬浮这两面交给 DSH 原生能力之后，
		 * "写了状态"不再等于"屏幕上出现了" —— 两处都先问一次、成了才写（见下面各分支）。
		 *
		 * 「本会话页签」与另外三个不同 —— 它是会话主体的一部分，所以要多做两件事：
		 *  1. 先把三个浮层都收掉：用户已经切到会话主体上了，浮层再盖在上面就等于没切；
		 *  2. 页签没切过去时（空白会话的头部是隐藏的、或者这个 DSH 改了页签 DOM）留一句
		 *     `open.placed`，把"手动点上方页签"这条退路说出来。
		 * 取不到当前会话则**什么都不动**，只留一句 `open.noSession`：这时候顺手关掉浮层
		 * 等于把用户扔到一个什么都没发生的地方 —— 那句话正是现在的做法，别丢。
		 *
		 * @param place   `LAYOUT_PLACES` 里的 key。不认识就拒绝（返回 false），不改任何状态。
		 * @param appId   要切过去的那一个小程序。
		 * @param env     `{ t, ctx }`：t 是文案；ctx 用来取当前会话并切页签（见 openInSession）。
		 * @returns 动作发出去了吗（**不是**"用户已经看到了"）。
		 */
		function switchLayout(place, appId, env) {
			if (typeof appId !== "string" || appId === "") return false;
			var target = findLayoutPlace(place);
			if (target === null) return false;
			var ctx = env === undefined || env === null ? undefined : env.ctx;
			var t = env !== undefined && env !== null && typeof env.t === "function" ? env.t : null;

			if (target.key === "panel") {
				// `runningId` 是**一次性命令**，不是一份状态：浮层读到它就把自己切到那一个
				// 小程序上，随后立刻清掉（见 MiniAppOverlay 里那段订阅）。
				ui.set({ open: true, runningId: appId });
				return true;
			}
			if (target.key === "drawer") {
				// 并列那一面走 **DSH 原生右栏**：先让它把我们那一格 tab 开出来，
				// **读回确认**之后再写状态 —— "界面说切了、其实没切"是这一路反复出现的
				// 失败形态（幽灵座位、`layout.openDetails` 不存在、`float()` 静默 return 都是它）。
				var opened = openRightbarPane(ctx);
				if (!opened.ok) {
					if (t !== null) ui.set({ toast: t("open.rightbarUnavailable") });
					return false;
				}
				ui.set({ drawer: true, drawerId: appId });
				return true;
			}
			if (target.key === "corner") {
				// 悬浮**只能由停靠态转入**（t31/t33 实测：`float()` 在 `host !== "dock"` 时
				// 静默 return）⇒ 先确保它停靠着，再求浮起；两步都读回确认。
				//
				// **降级已经删掉（2026-09）**：这里原来还有一条"老 DSH 上没有原生右栏服务时，
				// 退回自绘浮窗"的分支。它随自绘那一套一起退役 —— 两套并存正是这次要拆掉的东西，
				// 而且哪怕留着也没用：`Float()` 画不了、我们自己也不再画窗口，
				// 那条分支会写进 `corner: true` 而**屏幕上什么都没出现**。
				// 现在的取舍是有意的：老 DSH 上悬浮**如实失败**（一条 toast），
				// 用户知道这个构建上没有，而不是盯着一个假装的空白。
				var docked = openRightbarPane(ctx);
				if (docked.ok && floatRightbarPane(ctx).ok) {
					ui.set({ corner: true, cornerId: appId });
					return true;
				}
				if (t !== null) ui.set({ toast: t("open.rightbarUnavailable") });
				return false;
			}
			// 浏览器新页签在 DSH 之外：**不动任何一个浮层**。用户回来时原来那个面还在原处
			// —— 这是"新开一个"，不是"搬家"。
			if (target.key === "browser") return openInBrowser(appId);

			var sessionId = currentSessionId(ctx);
			if (sessionId === null) {
				if (t !== null) ui.set({ toast: t("open.noSession") });
				return false;
			}
			// 页签文字必须与登记时那个 label 同源，否则 focusSessionViewTab 按文字找不到它。
			var switched = openInSession(ctx, sessionId, appId, t === null ? "" : t("view.tab"));
			ui.set({ open: false, drawer: false, corner: false });
			if (!switched && t !== null) ui.set({ toast: t("open.placed") });
			return true;
		}

		/**
		 * 订阅目录 / 订阅某个会话的选中态。
		 *
		 * 用 useState + useEffect + subscribe（与 SidebarButton 同一条写法），
		 * 而不是 useSyncExternalStore：这里的两个 store 都可能**在 effect 里被换掉**
		 * （目录由别人加载完成、会话 id 变化），显式订阅语义更直白，也更容易在
		 * 没有真正 React 的测试里被驱动。
		 */
		function useCatalog() {
			var [state, setState] = useState(appCatalog.get());
			useEffect(function () {
				setState(appCatalog.get());
				return appCatalog.subscribe(function () { setState(appCatalog.get()); });
			}, []);
			return state;
		}

		function useSessionView(sessionId) {
			var [state, setState] = useState(sessionViewStore.snapshot(sessionId));
			useEffect(function () {
				setState(sessionViewStore.snapshot(sessionId));
				return sessionViewStore.subscribe(sessionId, function () {
					setState(sessionViewStore.snapshot(sessionId));
				});
			}, [sessionId]);
			return state;
		}

		// ------------------------------------------------------------ 通用控件
		//
		// 尺寸、圆角、间距、悬停行为都按原版取值，只把 Arco 的 token 换成 DSH 的。

		/**
		 * 主按钮（原版 `<Button type="primary">`）。
		 *
		 * **颜色**照抄 DSH 自己的主按钮规范（出处见 `T.buttonFill` 的注释）：
		 * 底色 `button-primary-fill`、文字 `label-primary-foreground`，悬停换成
		 * `button-primary-hover` 的底色 —— 不是降透明度。降透明度会让近白/近黑的
		 * 实心底往页面底色上"糊"，那正是这次要修掉的问题。
		 *
		 * **几何仍用这个移植版自己那套**（32 高 / 8 圆角 / mini 26），不跟 DSH 的
		 * 36 高胶囊走：DSH 里 `.primaryButton` 与 `.secondaryButton`/`.addButton`
		 * 共用同一组几何，而我们的次按钮、搜索框、对话框全都是 8 圆角那套 ——
		 * 只把主按钮改成胶囊，一行里就会一半胶囊一半方角，比现在更乱。
		 * 要整体换 DSH 的按钮语言，得连次按钮、搜索框、对话框一起换，那是另一件事。
		 */
		function PrimaryButton(props) {
			var [hover, setHover] = useState(false);
			var disabled = props.disabled === true;
			var mini = props.mini === true;
			return React.createElement("button", {
				type: "button",
				disabled: disabled,
				onClick: props.onClick,
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					boxSizing: "border-box",
					display: "inline-flex", flex: "0 0 auto", alignItems: "center",
					justifyContent: "center", gap: 4,
					height: mini ? 26 : 32, padding: mini ? "0 10px" : "0 14px",
					borderRadius: 8, border: "none",
					// 悬停换底色；禁用时不再高亮（DSH 那边是 `:hover:not(:disabled)`）。
					background: hover && !disabled ? T.buttonHover : T.buttonFill,
					color: T.onBrand,
					font: "inherit", fontSize: mini ? 12 : 13, fontWeight: 500,
					cursor: disabled ? "not-allowed" : "pointer",
					opacity: disabled ? 0.55 : 1,
					whiteSpace: "nowrap", transition: "background-color 120ms"
				}
			},
				props.icon ? React.createElement(Icon, { name: props.icon, size: props.mini ? 14 : 15 }) : null,
				React.createElement("span", null, props.label)
			);
		}

		/** 次按钮（原版默认 `<Button>`）。 */
		function GhostButton(props) {
			var [hover, setHover] = useState(false);
			return React.createElement("button", {
				type: "button", disabled: props.disabled === true, onClick: props.onClick,
				title: props.title,
				// 给测试与将来的调试一个稳定的抓手：按钮的形状会变，这个记号不会。
				"data-action": props.action,
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					display: "inline-flex", flex: "0 0 auto", alignItems: "center", gap: 6,
					height: props.mini ? 26 : 32, padding: props.mini ? "0 10px" : "0 14px",
					borderRadius: 8,
					border: "1px solid " + (hover ? T.border2 : T.border1),
					background: hover ? T.fill : T.bgLayer1,
					color: T.text1, font: "inherit", fontSize: props.mini ? 12 : 13,
					cursor: props.disabled === true ? "not-allowed" : "pointer",
					opacity: props.disabled === true ? 0.55 : 1,
					whiteSpace: "nowrap",
					transition: "background 120ms, border-color 120ms"
				}
			},
				props.icon ? React.createElement(Icon, { name: props.icon, size: props.mini ? 14 : 15 }) : null,
				React.createElement("span", null, props.label)
			);
		}

		/** 表单输入（原版 Arco Input）。对话框里仍是 <input>/<textarea>，所以给出常量。 */
		var FIELD_STYLE = {
			font: "inherit", fontSize: 13, lineHeight: "18px", color: T.text1,
			background: T.fill, border: "1px solid " + T.border2, borderRadius: 8,
			padding: "7px 10px", width: "100%", boxSizing: "border-box", outline: "none"
		};

		/** 内联次按钮：与 GhostButton 同一套取值，供仍用 <button> 的地方复用。 */
		var INLINE_GHOST = {
			display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 14px",
			borderRadius: 8, border: "1px solid " + T.border1, background: T.bgLayer1,
			color: T.text1, font: "inherit", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap"
		};

		/**
		 * 内联主按钮 —— 与 `PrimaryButton` 是**同一枚按钮的两种写法，必须逐项一致**。
		 *
		 * 所以下面把几何、字号、底色、文字色又写了一遍，而不是只从 INLINE_GHOST 继承
		 * 底色/文字：主按钮那套数字来自 DSH 的主按钮规范（见 PrimaryButton 的注释），
		 * 次按钮那套是另一套（32 高 / 8 圆角），只改颜色的继承会让两者悄悄漂移。
		 */
		var INLINE_PRIMARY = Object.assign({}, INLINE_GHOST, {
			boxSizing: "border-box", justifyContent: "center", gap: 4,
			height: 32, padding: "0 14px", borderRadius: 8, border: "none",
			background: T.buttonFill, color: T.onBrand,
			fontSize: 13, fontWeight: 500
		});

		/**
		 * 内联危险主按钮。
		 *
		 * 底色 `T.danger` + 文字 `T.onBrand`：DSH 自己的 dangerButton 其实是描边的
		 * （`background:0 0; color:var(--dsw-alias-state-error-primary)`），但这里的
		 * 危险动作是"删除一个小程序"这种已成定局的确认，实心更明确。
		 * 文字用 token 而不是写死的 `#fff`：深色主题的 danger 是偏亮的 #f25a5a，
		 * 配 token（近黑）才读得出来，写死白色会糊在亮红上。
		 */
		var INLINE_DANGER = Object.assign({}, INLINE_GHOST, {
			border: "1px solid " + T.danger, background: T.danger, color: T.onBrand
		});

		/** 对话框右上角的纯图标关闭按钮。 */
		var INLINE_ICON_BUTTON = {
			display: "grid", placeItems: "center", width: 26, height: 26, flex: "0 0 auto",
			borderRadius: 8, border: 0, background: "transparent",
			color: T.text2, cursor: "pointer"
		};

		/** 禁用态：内联样式表达不了 :disabled，所以显式叠加。 */
		var DISABLED_STYLE = { opacity: 0.55, cursor: "not-allowed" };

		// -------------------------------------------------------------- 库页面
		//
		// 对齐原版 `pages/miniApps/index.tsx`：标题行（标题 + 副标题，右侧搜索 /
		// 导入 / 创建）、卡片网格、空态。卡片是**横向**布局：44×44 图标块 + 内容列，
		// 「打开使用」常驻在卡片右下，其余三个动作只在悬停时以 26×26 图标出现。

		/** 「打开使用」：整卡可点，但这个动词必须不靠悬停就能看见。 */
		var CARD_OPEN_STYLE = {
			display: "inline-flex", flex: "0 0 auto", alignItems: "center", gap: 3,
			height: 24, padding: "0 9px", borderRadius: 8, cursor: "pointer",
			border: "1px solid " + tint(T.brand, 32),
			background: tint(T.brand, 10),
			font: "inherit", fontSize: 12, fontWeight: 600, lineHeight: 1, color: T.brand
		};

		/**
		 * 26×26 的图标动作：卡片右上角、以及标题栏下拉面板里每一行末尾的那两枚
		 * （📌 与 ⋮）都用它 —— 同一个尺寸、同一套悬停，两个地方不该各画一份。
		 *
		 * 三个可选参数是给面板里那两枚用的，卡片那一版一个都不传，渲染结果逐字段不变：
		 *  * `stroke`：图标走描边分支（📌 的**未固定**态是一个空心图钉，实心画法画不出来）；
		 *  * `attrs`：额外的属性（`aria-pressed` 表固定态、`data-*` 给测试与排障一个抓手）；
		 *  * `nodeRef`：把节点本身交出去 —— ⋮ 菜单要量它的矩形才能贴着它画。
		 */
		function CardAction(props) {
			var [hover, setHover] = useState(false);
			var danger = props.danger === true;
			return React.createElement("div", Object.assign({
				role: "button", tabIndex: 0,
				title: props.label, "aria-label": props.label,
				ref: props.nodeRef,
				onClick: props.onRun,
				onKeyDown: function (event) {
					if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onRun(); }
				},
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					display: "grid", placeItems: "center", width: 26, height: 26,
					borderRadius: 8, cursor: "pointer",
					border: "1px solid " + (danger && hover ? tint(T.danger, 40) : hover ? T.border2 : T.border1),
					background: danger && hover ? tint(T.danger, 8) : hover ? T.fill : T.bgLayer1,
					color: danger && hover ? T.danger : hover ? T.text1 : T.text2,
					transition: "color 120ms, background 120ms, border-color 120ms"
				}
			}, props.attrs), React.createElement(Icon, {
				name: props.icon, size: 14, stroke: props.stroke === true
			}));
		}

		function AppCard(props) {
			var app = props.app;
			var t = props.t;
			var [hover, setHover] = useState(false);
			var icon = (app.icon || "").trim();
			var description = (app.description || "").trim();

			return React.createElement("div", {
				onClick: function () { props.onOpen(app); },
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					position: "relative", display: "flex", gap: 12, overflow: "hidden",
					boxSizing: "border-box", padding: 14, borderRadius: 14, cursor: "pointer",
					border: "1px solid " + (hover ? T.border2 : T.border1),
					background: T.bgLayer1,
					transform: hover ? "translateY(-2px)" : "none",
					boxShadow: hover ? "0 12px 30px rgba(0,0,0,0.12)" : "none",
					transition: "border-color 160ms, box-shadow 160ms, transform 160ms"
				}
			},
				React.createElement("span", {
					"aria-hidden": "true",
					style: {
						display: "grid", placeItems: "center", width: 44, height: 44,
						flex: "0 0 auto", borderRadius: 12, background: T.fill,
						fontSize: 22, lineHeight: 1, color: T.brand
					}
				}, icon.length > 0 ? icon : React.createElement(Icon, { name: "app", size: 22 })),

				React.createElement("div", {
					style: { display: "flex", minWidth: 0, flex: 1, flexDirection: "column", gap: 4 }
				},
					React.createElement("div", { style: { display: "flex", minWidth: 0, alignItems: "center", gap: 6 } },
						React.createElement("span", {
							style: {
								overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
								fontSize: 15, fontWeight: 600, lineHeight: 1.35, color: T.text1
							}
						}, app.name),
						app.has_unpublished_changes ? React.createElement("span", {
							title: t("publish.explain"),
							style: {
								flex: "0 0 auto", borderRadius: 999, padding: "1px 6px",
								fontSize: 10, fontWeight: 600, lineHeight: "16px",
								color: T.warn, background: tint(T.warn, 12)
							}
						}, t("publish.pending")) : null
					),
					description.length > 0 ? React.createElement("div", {
						style: Object.assign({}, TEXT3, {
							fontSize: 12, lineHeight: "17px",
							display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
							overflow: "hidden"
						})
					}, description) : null,
					React.createElement("div", {
						style: {
							marginTop: "auto", display: "flex", alignItems: "center",
							justifyContent: "space-between", gap: 8, paddingTop: 6
						}
					},
						React.createElement("span", {
							style: Object.assign({}, TEXT3, {
								minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
								whiteSpace: "nowrap", fontSize: 11, lineHeight: "15px"
							})
						}, t("list.updatedAt", { time: relativeTime(t, app.updated_at) })),
						React.createElement("button", {
							type: "button", title: t("actions.open"), style: CARD_OPEN_STYLE,
							onClick: function (event) { event.stopPropagation(); props.onOpen(app); }
						},
							React.createElement("span", null, t("actions.open")),
							React.createElement(Icon, { name: "right", size: 12 })
						)
					)
				),

				React.createElement("div", {
					onClick: function (event) { event.stopPropagation(); },
					style: {
						position: "absolute", top: 10, right: 10, display: "flex", gap: 6,
						pointerEvents: hover ? "auto" : "none",
						opacity: hover ? 1 : 0,
						transition: "opacity 150ms"
					}
				},
					React.createElement(CardAction, {
						icon: "wand", label: t("iterate.toggle"),
						onRun: function () { props.onIterate(app); }
					}),
					React.createElement(CardAction, {
						icon: "edit", label: t("actions.rename"),
						onRun: function () { props.onRename(app); }
					}),
					React.createElement(CardAction, {
						icon: "trash", label: t("actions.delete"), danger: true,
						onRun: function () { props.onDelete(app); }
					})
				)
			);
		}

		function EmptyState(props) {
			var t = props.t;
			return React.createElement("div", {
				style: {
					display: "flex", flexDirection: "column", alignItems: "center",
					justifyContent: "center", gap: 14, padding: "64px 24px", textAlign: "center"
				}
			},
				React.createElement("span", {
					style: {
						display: "flex", width: 72, height: 72, alignItems: "center",
						justifyContent: "center", borderRadius: "50%", background: T.fill, color: T.brand
					}
				}, React.createElement(Icon, { name: "app", size: 32 })),
				React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
					React.createElement("span", { style: { fontSize: 15, fontWeight: 600, color: T.text1 } },
						t("empty.title")),
					React.createElement("span", {
						style: Object.assign({}, TEXT3, { maxWidth: 460, fontSize: 13, lineHeight: "19px" })
					}, t("empty.description"))
				),
				React.createElement("div", {
					style: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 10 }
				},
					React.createElement(PrimaryButton, { icon: "plus", label: t("empty.cta"), onClick: props.onCreate }),
					React.createElement(GhostButton, { icon: "upload", label: t("import.entry"), onClick: props.onImport })
				)
			);
		}

		function LibraryView(props) {
			var t = props.t;
			var apps = props.apps;
			var [query, setQuery] = useState("");
			var shown = useMemo(function () {
				var needle = query.trim().toLowerCase();
				if (needle.length === 0) return apps;
				return apps.filter(function (app) {
					return (app.name || "").toLowerCase().includes(needle)
						|| (app.description || "").toLowerCase().includes(needle);
				});
			}, [apps, query]);

			// 原版只在「没有出错且确实有内容」时才给出工具行 —— 首屏加载中不给搜索框。
			var showTools = props.error === null && (apps.length > 0 || props.loading);

			return React.createElement("div", {
				style: { display: "flex", flexDirection: "column", gap: 20, minHeight: 0, flex: 1 }
			},
				React.createElement("div", {
					style: {
						display: "flex", width: "100%", flexWrap: "wrap",
						alignItems: "flex-start", justifyContent: "space-between",
						columnGap: 20, rowGap: 12
					}
				},
					React.createElement("div", { style: { minWidth: 0 } },
						React.createElement("h1", {
							style: { margin: 0, marginBottom: 3, fontSize: 22, fontWeight: 600, lineHeight: 1.25, color: T.text1 }
						}, t("title")),
						React.createElement("p", {
							style: Object.assign({}, TEXT3, { margin: 0, maxWidth: 560, fontSize: 13, lineHeight: "19px" })
						}, t("subtitle"))
					),
					showTools ? React.createElement("div", {
						style: { display: "flex", alignItems: "center", gap: 10 }
					},
						React.createElement("label", {
							style: {
								display: "flex", width: 200, alignItems: "center", gap: 8,
								height: 34, boxSizing: "border-box",
								borderRadius: 10, border: "1px solid " + T.border2,
								background: T.fill, padding: "0 12px"
							}
						},
							React.createElement("span", { style: { display: "flex", flex: "0 0 auto", color: T.text2 } },
								React.createElement(Icon, { name: "search", size: 14 })),
							React.createElement("input", {
								value: query,
								onChange: function (event) { setQuery(event.target.value); },
								placeholder: t("list.searchPlaceholder"),
								style: {
									width: "100%", minWidth: 0, border: 0, background: "transparent",
									font: "inherit", fontSize: 13, color: T.text1, outline: "none"
								}
							})
						),
						React.createElement(GhostButton, { icon: "upload", label: t("import.entry"), onClick: props.onImport }),
						React.createElement(PrimaryButton, { icon: "plus", label: t("actions.create"), onClick: props.onCreate }),
						React.createElement("button", {
							type: "button", title: t("actions.close"), "aria-label": t("actions.close"),
							onClick: props.onClose,
							style: Object.assign({}, INLINE_ICON_BUTTON, { width: 32, height: 32 })
						}, React.createElement(Icon, { name: "close", size: 16 }))
					) : null
				),

				props.error !== null ? React.createElement("div", {
					style: {
						display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
						padding: "56px 24px", textAlign: "center"
					}
				},
					React.createElement("span", { style: { fontSize: 15, fontWeight: 600, color: T.danger } }, t("errors.loadListFailed")),
					React.createElement("span", {
						style: Object.assign({}, TEXT3, { fontSize: 13, maxWidth: 520, wordBreak: "break-word" })
					}, props.error),
					React.createElement(GhostButton, { label: t("actions.refresh"), onClick: props.onRefresh })
				)
				: props.loading && apps.length === 0 ? React.createElement("div", {
					style: { display: "flex", justifyContent: "center", padding: "56px 0" }
				}, React.createElement("span", { style: Object.assign({}, TEXT3, { fontSize: 13 }) }, t("list.loading")))
				: apps.length === 0 ? React.createElement(EmptyState, {
					t: t, onCreate: props.onCreate, onImport: props.onImport
				})
				: React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14, minHeight: 0 } },
					React.createElement("div", {
						style: {
							display: "grid", gap: 14, minHeight: 0, overflowY: "auto", paddingBottom: 4,
							gridTemplateColumns: "repeat(auto-fill, minmax(min(280px, 100%), 1fr))"
						}
					},
						shown.map(function (app) {
							return React.createElement(AppCard, {
								key: app.miniapp_id, app: app, t: t,
								onOpen: props.onOpen, onIterate: props.onIterate,
								onRename: props.onRename, onDelete: props.onDelete
							});
						})
					),
					shown.length === 0 ? React.createElement("div", {
						style: Object.assign({}, TEXT3, { padding: "40px 0", textAlign: "center", fontSize: 13 })
					}, t("list.filterEmpty")) : null
				)
			);
		}

		// -------------------------------------------------------------- 运行页
		//
		// 对齐原版 `pages/miniApps/RunnerPage.tsx`：一条 52px 工具栏、一行未发布说明、
		// 然后是占满剩余高度的沙箱 iframe。工具栏最左是返回，接着是 28×28 图标块与标题，
		// 其余动作靠右；只有「发布」和「继续迭代」带文字 —— 它们是这里唯一不明显、
		// 也是唯一会离开当前视图的两个控制。

		/**
		 * 32×32 工具栏图标动作。
		 *
		 * 两个可选参数给标题栏上的小程序栏用（其余调用方一个都不传，渲染结果逐字段不变）：
		 *  * `content`：换掉里面那个图标 —— 固定的那个小程序画的是**它自己的 emoji**，
		 *    而不是一枚通用图标；
		 *  * `attrs`：额外的属性（`aria-expanded` 表下拉面板的开合、`data-*` 给测试与排障一个抓手）。
		 */
		function ToolbarAction(props) {
			var [hover, setHover] = useState(false);
			var danger = props.danger === true;
			return React.createElement("div", Object.assign({
				role: "button", tabIndex: 0,
				title: props.label, "aria-label": props.label,
				onClick: props.onRun,
				onKeyDown: function (event) {
					if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onRun(); }
				},
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					display: "grid", placeItems: "center", width: 32, height: 32,
					flex: "0 0 auto", borderRadius: 8, cursor: "pointer",
					color: danger && hover ? T.danger : hover ? T.text1 : T.text2,
					background: danger && hover ? tint(T.danger, 8) : hover ? T.fill : "transparent",
					transition: "color 120ms, background 120ms"
				}
			}, props.attrs),
				props.content === undefined ? React.createElement(Icon, { name: props.icon, size: 16 }) : props.content
			);
		}

		/**
		 * 「切换布局」里的一枚：`LAYOUT_SWITCH_SIZE` 见方的图标动作。
		 *
		 * 与 `ToolbarAction` **同一套观感与几何**（同一组样式项、同样的 role/tabIndex/
		 * 悬停语义、Enter 与空格都算激活），只有尺寸与图标小一档 —— 五枚要连着排进
		 * 每个运行面头部那一行（原生右栏那一列本来就不宽）。
		 *
		 * 「当前所在的那一个」有两重表达，两个都要有：
		 *  * `aria-pressed="true"` —— 读屏用户与测试都靠它，视觉态是给人看的、抓不住；
		 *  * 高亮（品牌色文字 + 12% 品牌底色）与 `cursor: default` —— 明说"你就在这儿"。
		 * 当前那一枚**点下去什么都不做**：真正的切换都是"先关掉自己再开另一个"，
		 * 自己点自己却去关一遍再开一遍，会让正在跑的小程序重挂一次 iframe（丢状态）。
		 */
		function LayoutSwitchButton(props) {
			var [hover, setHover] = useState(false);
			var active = props.active === true;
			var run = function () { if (!active) props.onRun(); };
			return React.createElement("div", {
				role: "button", tabIndex: 0,
				title: props.label, "aria-label": props.label,
				"aria-pressed": active ? "true" : "false",
				// 给测试与真机排障一个稳定的抓手（不用去猜第几枚按钮）。
				"data-dsh-miniapp-layout": props.place,
				onClick: run,
				onKeyDown: function (event) {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					run();
				},
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					display: "grid", placeItems: "center",
					width: LAYOUT_SWITCH_SIZE, height: LAYOUT_SWITCH_SIZE,
					flex: "0 0 auto", borderRadius: 8,
					cursor: active ? "default" : "pointer",
					color: active ? T.brand : hover ? T.text1 : T.text2,
					background: active ? tint(T.brand, 12) : hover ? T.fill : "transparent",
					transition: "color 120ms, background 120ms"
				}
			}, React.createElement(Icon, { name: props.icon, size: 14 }));
		}

		/**
		 * 五个「跑的地方」那一排按钮 —— 四个头的共用件。
		 *
		 * 顺序、图标、文案全部来自 `LAYOUT_PLACES`，这里不写死任何一枚；`current` 是
		 * "我现在在哪儿"，由调用方给（它当然知道自己被渲染在哪个面里）。
		 *
		 * 只画按钮本身、**不自己动手切换**：动作是 `props.onSwitch(place, appId)`，
		 * 于是这个组件在测试里可以直接被驱动，不需要一整套 ui / ctx / window 替身；
		 * 真机上那个回调就是 `switchLayout`（见那儿的说明）。
		 */
		function LayoutSwitcher(props) {
			var t = props.t;
			return React.createElement("div", {
				role: "group",
				"aria-label": t("layout.label"),
				// `flex: "0 0 auto"`：头部宽度不够时该被压缩的是**名字**，不是这排按钮。
				style: { display: "flex", alignItems: "center", gap: LAYOUT_SWITCH_GAP, flex: "0 0 auto" }
			}, LAYOUT_PLACES.map(function (place) {
				return React.createElement(LayoutSwitchButton, {
					key: place.key,
					place: place.key,
					icon: place.icon,
					label: t(place.labelKey),
					active: place.key === props.current,
					onRun: function () { props.onSwitch(place.key, props.appId); }
				});
			}));
		}

		/** 看护条上的小动作。 */
		function HintButton(props) {
			var [hover, setHover] = useState(false);
			return React.createElement("button", {
				type: "button", onClick: props.onClick,
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					display: "inline-flex", flex: "0 0 auto", alignItems: "center", gap: 4,
					height: 24, padding: "0 8px", borderRadius: 8, cursor: "pointer",
					border: "1px solid " + (hover ? T.border2 : T.border1),
					background: hover ? T.fill : T.bgLayer1,
					color: hover ? T.text1 : T.text2,
					font: "inherit", fontSize: 12, lineHeight: 1,
					transition: "color 120ms, background 120ms, border-color 120ms"
				}
			},
				props.icon ? React.createElement(Icon, { name: props.icon, size: 12 }) : null,
				React.createElement("span", null, props.label)
			);
		}

		/**
		 * 运行页。
		 *
		 * `props.chrome` 决定画哪一条工具栏 —— **同一个组件、同一份 iframe**，
		 * 只是露出来的动作不同：
		 *
		 *  * `"full"`（默认）—— 全屏浮层：返回 / 发布 / 继续迭代 / 重命名 / 删除 / 关闭，
		 *    外加「切换布局」那一排（`layoutCurrent: "panel"`）；
		 *  * `"compact"` —— 会话页签：只留「刷新 / 切换布局 / 关闭」，`layoutCurrent`
		 *    是 `"session"`。这里是会话区，不该出现那两枚带文字的大按钮（发布、继续迭代），
		 *    它们会把会话的头压得很重；
		 *  * `"none"` —— 只给旧的"自绘贴边面"用的那一档（它们自己有一行头：名字 +
		 *    切换布局 + 关闭，再画一条工具栏就是两条头）。**2026-09 之后没有生产调用点**：
		 *    右栏那一格与悬浮都改走 DSH 原生能力，现在活着的三个面分别用 `"full"`（面板）
		 *    与 `"compact"`（会话页签、右栏那一格）。这一档留着是因为 `chrome` 是一条
		 *    **三个值的契约**，删一个值会让"不画工具栏"这个语义无处安放。
		 *
		 * 两个 prop 一起决定那一排按钮的去留：`onSwitchLayout(place, appId)` 是"切过去
		 * 到底做什么"（真机上就是 `switchLayout`，见那儿），`layoutCurrent` 是"我这一版
		 * 正站在哪个地方" —— 少了它，切换控件就不知道该把哪一枚标成当前。
		 * 不再有 `onOpenInSession` / `onOpenInDrawer` / `onOpenInCorner` 这三个单点入口：
		 * 它们正好是这五枚里的三枚。
		 */
		/**
		 * 「还没有发布过」的空态 —— RunnerView 里**新增加**的一条分支。
		 *
		 * 为什么需要它：直出通道对一个从未发布过的 id 只会 404（`readSnapshot()` 为
		 * undefined），而原来 RunnerView **无条件**挂 iframe —— 于是那段"缺口"响应被当成
		 * 文档渲染出来，用户在预览区看到的是原始 JSON。信息其实一直在手里
		 * （`app.published_at`），只是没被消费。
		 *
		 * 判别式**不能**用 `has_unpublished_changes`：后者对"从未发布"和"发布过之后又
		 * 改了工作副本"**都为真**（`lib/store.js:261-262`），拿它当守卫会在用户迭代一次
		 * 之后，把**本来能正常渲染的**预览换成这个空态。
		 *
		 * 它也**不能只信手里那条记录**：`app.published_at === null` 说的是"我手上这一条
		 * 没发布过"，不是"宿主上没有快照"—— 宿主侧那个判据（直出 404 用的
		 * `readSnapshot() === undefined`）要由 RunnerView **向宿主确认一次**之后才落到这里
		 * （t18 把这条数据带进了渲染决策、t24 把判据改成 fail-open，见上面那段长注释）。
		 * 于是这个空态现在只出现在**宿主也确认过**的那一侧 —— 这正是「发布」按钮此刻
		 * 按下去有意义的前提。
		 *
		 * 「发布」按钮**复用** RunnerView 那条既有链（同一个 `publish` 回调 → `props.onPublished()`
		 * 刷新目录 → 重挂 iframe），所以：① 四个运行面（**面板 / 右栏那一格 / 会话页签 /
		 * 悬浮面**，共用 RunnerView）行为一致；
		 * ② 发布后原地变成可运行，不需要手动刷新；③ 发布仍然是用户的**显式动作**。
		 *
		 * 刻意**不看** `chrome`：右栏那一格与悬浮面**不画工具栏**，若把按钮寄托在
		 * 工具栏上，那两个面就没有出口了。
		 */
		function MiniAppNotPublished(props) {
			var t = props.t;
			return React.createElement("div", {
				// 给后续的回归测试一个稳定抓手（形状会变，这个记号不会）。
				"data-dsh-miniapp-not-published": "",
				style: {
					flex: 1, minHeight: 0, display: "grid", placeItems: "center",
					padding: 24, background: T.bgBase
				}
			},
				React.createElement("div", {
					style: {
						display: "flex", flexDirection: "column", alignItems: "center",
						gap: 12, maxWidth: 420, textAlign: "center"
					}
				},
					React.createElement("span", {
						style: {
							display: "flex", width: 64, height: 64, alignItems: "center",
							justifyContent: "center", borderRadius: "50%",
							background: T.fill, color: T.brand, fontSize: 26
						}
					}, props.icon.length > 0 ? props.icon : React.createElement(Icon, { name: "app", size: 26 })),
					React.createElement("span", {
						style: { fontSize: 15, fontWeight: 600, color: T.text1 }
					}, t("notPublished.title")),
					React.createElement("span", {
						style: Object.assign({}, TEXT3, { fontSize: 13, lineHeight: "20px" })
					}, t("notPublished.body")),
					React.createElement(PrimaryButton, {
						icon: "upload", disabled: props.busy,
						label: props.busy ? t("publish.publishing") : t("publish.action"),
						onClick: props.onPublish
					})
				)
			);
		}

		function RunnerView(props) {
			var t = props.t;
			var app = props.app;
			var chrome = props.chrome === undefined ? "full" : props.chrome;
			var compact = chrome === "compact";
			var toolbar = chrome !== "none";
			var [reloadToken, setReloadToken] = useState(0);
			var [retryToken, setRetryToken] = useState(0);
			var [stalled, setStalled] = useState(false);
			var [dismissed, setDismissed] = useState(false);
			var [busy, setBusy] = useState(false);
			var [error, setError] = useState(null);
			var watchdog = useRef(null);

			var mountKey = app.miniapp_id + ":" + reloadToken + ":" + retryToken;
			var icon = (app.icon || "").trim();
			// ---- 空态判据：必须是**宿主确认过**的"从未发布"，不能只信手里的缓存。----
			//
			// 为什么不能只信缓存（t18 引入、用户实测到的缺陷）：`published_at === null`
			// 只说明"**我们手上这条记录**说它没发布过"，**不说明宿主那边没有快照**。
			// 运行面的数据可能来自一份过期目录，而"打开"这个动作并不保证它新鲜：
			// 每一个运行面（原生右栏那一格 / 本会话页签 / 全屏面板）打开时调的都是
			// `appCatalog.load(false)`，而 `load(false)` 的语义就是"已经加载过就不再打请求"
			// （`state.loaded === true` 直接 return）。
			// 于是"发布之前加载过目录"的上下文会一直拿着 `published_at: null`，
			// 把**已经发布**的小程序永久显示成空态。
			//
			// 而这个数据在 t18 之前**根本不影响渲染**（iframe 不需要 `published_at`），
			// 所以这是 t18 新引入的一类失败：把一个权威性要求带进了渲染决策，却建立在
			// 可能过期的客户端缓存上。修法**不是在两个调用点补 refresh**（那要论证"任意面
			// 在任意时刻都可能持有陈旧目录"，补不完），而是**把判据本身改成 fail-open**：
			//
			//   缓存说"没发布"时，先**照常渲染文档**（最坏不过是 iframe 里那份人话占位文档，
			//   不再是原始 JSON），同时向宿主**确认一次**（`GET /apps/<id>` 就是权威记录）；
			//   **只有宿主也确认"从未发布"**，才切成空态。
			//
			// 判别式放在共享的 `RunnerView` 里，所以四个运行面（同上面那四个：面板 /
			// 右栏那一格 / 会话页签 / 悬浮面）同时受益 —— 这正是
			// "任意面在任意时刻都可能持有陈旧目录"的答案：**不再让渲染决策依赖那份缓存**。
			//
			// 另外仍然**只认显式的 `null`**：`undefined`（字段缺失）时我们对这个 id 一无所知，
			// 按老路径挂 iframe 是失败方向更安全的一侧。
			var [hostConfirmedNeverPublished, setHostConfirmedNeverPublished] = useState(false);
			// 刷新口用 ref 保活：它的**身份**每个父级渲染都会变（多处是就地写的箭头函数），
			// 若把它放进确认 effect 的依赖表，父级一渲染就会重打一次确认请求 —— 那是把一个
			// 只该发生一次的网络动作绑到了渲染节奏上。依赖表因此只留两个**值**。
			var refreshRef = useRef(null);
			useEffect(function () {
				refreshRef.current = typeof props.onRefresh === "function" ? props.onRefresh : null;
			}, [props.onRefresh]);
			useEffect(function () {
				if (app.published_at !== null) {
					setHostConfirmedNeverPublished(false);
					return undefined;
				}
				var alive = true;
				void callApi("/apps/" + app.miniapp_id).then(function (record) {
					if (!alive) return;
					var published = record !== null && typeof record === "object" && record.published_at !== null;
					setHostConfirmedNeverPublished(!published);
					if (!published) return;
					// 宿主说"它有快照" ⇒ 手里那份是陈旧的。目录是模块级的：刷新一次，
					// 别的面（含两个悬浮面）下一帧就跟着对了；本面若自带刷新口也一并叫一下
					// （全屏面板的 app 来自它自己的局部状态，光刷目录改不到它）。
					void appCatalog.load(true);
					if (refreshRef.current !== null) refreshRef.current();
				}, function () {
					// 确认不了（离线 / 老宿主 / 记录已删）**就不藏** —— 保持"照常渲染"，
					// 让文档自己说话。这一侧的错误只会多显示一份占位文档，不会藏掉内容。
				});
				return function () { alive = false; };
			}, [app.miniapp_id, app.published_at]);
			var neverPublished = app.published_at === null && hostConfirmedNeverPublished === true;

			// 每次重挂都重新计时：外部刷新、重试、切换小程序都会换 mountKey。
			// 这里只能抓到「从未提交文档」的框；抓不到白屏 —— 被嵌入策略拒绝的
			// 文档照样在 iframe 元素上触发 load，而沙箱不给同源访问，宿主侧无法
			// 检视渲染结果。所以不要在 load 之后继续保留这个定时器。
			useEffect(function () {
				setStalled(false);
				setDismissed(false);
				if (watchdog.current !== null) window.clearTimeout(watchdog.current);
				watchdog.current = window.setTimeout(function () {
					watchdog.current = null;
					setStalled(true);
				}, WATCHDOG_MS);
				return function () {
					if (watchdog.current !== null) window.clearTimeout(watchdog.current);
					watchdog.current = null;
				};
			}, [mountKey]);

			var onLoad = useCallback(function () {
				if (watchdog.current !== null) { window.clearTimeout(watchdog.current); watchdog.current = null; }
				setStalled(false);
			}, []);

			var publish = useCallback(async function () {
				setBusy(true);
				setError(null);
				try {
					await callApi("/apps/" + app.miniapp_id + "/publish", { method: "POST" });
					// 快照在活着的 iframe 底下换了：只重挂 iframe 会让用户看到旧版本，
					// 只刷新元数据会让「有未发布改动」消失而页面没变，两件事都要做。
					props.onPublished();
					setReloadToken(function (value) { return value + 1; });
				} catch (publishError) {
					setError(t("publish.failed", { message: publishError.message }));
				} finally {
					setBusy(false);
				}
			}, [app.miniapp_id, props, t]);

			var openExternally = useCallback(function () {
				// URL 只在 `openInBrowser` 里拼一次 —— 切换控件里浏览器那一枚走的是同一个。
				openInBrowser(app.miniapp_id);
			}, [app.miniapp_id]);

			return React.createElement("div", {
				style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, width: "100%" }
			},
				// 工具栏（`chrome === "none"` 的那两个面不画它，见上面的说明）。
				toolbar ? React.createElement("div", {
					style: {
						flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10,
						height: 52, padding: "0 16px", boxSizing: "border-box",
						background: T.bgLayer1, borderBottom: "1px solid " + T.border1
					}
				},
					// 会话页签里没有"返回"这一站：它左边就是「会话」「轨迹」。
					compact ? null : React.createElement(ToolbarAction, { icon: "back", label: t("actions.back"), onRun: props.onBack }),
					React.createElement("span", {
						"aria-hidden": "true",
						style: {
							display: "flex", alignItems: "center", justifyContent: "center",
							width: 28, height: 28, flex: "0 0 auto", borderRadius: 8,
							fontSize: 16, lineHeight: 1, color: T.brand, background: tint(T.brand, 12)
						}
					}, icon.length > 0 ? icon : React.createElement(Icon, { name: "app", size: 16 })),
					React.createElement("span", {
						style: {
							minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
							whiteSpace: "nowrap", fontSize: 15, fontWeight: 700, color: T.text1
						}
					}, app.name),
					React.createElement("div", {
						style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }
					},
						compact ? null : (app.has_unpublished_changes ? React.createElement(PrimaryButton, {
							mini: true, icon: "upload", disabled: busy,
							label: busy ? t("publish.publishing") : t("publish.action"),
							onClick: publish
						}) : null),
						compact ? null : React.createElement(GhostButton, {
							mini: true, icon: "wand", label: t("iterate.toggle"),
							onClick: function () { props.onIterate(app); }
						}),
						React.createElement(ToolbarAction, {
							icon: "refresh", label: t("actions.refresh"),
							onRun: function () {
								setReloadToken(function (value) { return value + 1; });
								props.onRefresh();
							}
						}),
						// 「换个地方」那一排：五枚按钮（面板 / 右栏 / 本会话页签 / 悬浮 /
						// 浏览器新页签），当前所在的那一枚带 `aria-pressed`。
						//
						// 它**取代**了以前那四枚（浏览器 + 三个位置），而那四枚正好就是这五枚
						// 里的四枚：留着就是同一件事两套入口 —— 用户会看见两个「在浏览器中
						// 打开」。所以「在浏览器中打开」那枚独立的 ToolbarAction 在这里删掉了，
						// 它现在活在切换控件里（`openExternally` 仍然给看护条那条降级入口用）。
						// 顺序与文案全由 `LAYOUT_PLACES` 给，这里不写死。
						//
						// `onSwitchLayout` 由外壳传进来（浮层 / 页签各自知道自己是哪个面）；
						// `layoutCurrent` 就是"我现在这个面" —— 那一枚因此永远不会点到自己。
						props.onSwitchLayout === undefined ? null : React.createElement(LayoutSwitcher, {
							t: t, appId: app.miniapp_id,
							current: props.layoutCurrent,
							onSwitch: props.onSwitchLayout
						}),
						compact ? null : React.createElement(ToolbarAction, { icon: "edit", label: t("actions.rename"), onRun: function () { props.onRename(app); } }),
						compact ? null : React.createElement(ToolbarAction, { icon: "trash", label: t("actions.delete"), danger: true, onRun: function () { props.onDelete(app); } }),
						React.createElement(ToolbarAction, { icon: "close", label: t("actions.close"), onRun: props.onClose })
					)
				) : null,

				// 一行说明用户改动现在处于哪一层 —— 或者还没到哪一层。
				//
				// **从未发布时不画它**：这条 bar 的第一句是「当前运行的是已发布版本」（t("publish.explain")），
				// 而没有快照时根本没有"已发布版本"可言 —— 与下面的空态摆在一起会自相矛盾。
				// 注意这不是改它的逻辑：已发布的小程序（`published_at !== null`）走的分支一字未动，
				// 它要讲的"迭代后预览还是旧的"那件事完全不受影响。
				!neverPublished && app.has_unpublished_changes ? React.createElement("div", {
					role: "status",
					style: {
						flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8,
						padding: "6px 16px", background: tint(T.warn, 8),
						borderBottom: "1px solid " + T.border1
					}
				},
					React.createElement("span", {
						style: { flex: "0 0 auto", fontSize: 12, fontWeight: 600, color: T.warn }
					}, t("publish.pending")),
					React.createElement("span", {
						style: { minWidth: 0, fontSize: 12, lineHeight: "18px", color: T.text2 }
					}, t("publish.explain"))
				) : null,

				error !== null ? React.createElement("div", {
					role: "status",
					style: {
						flex: "0 0 auto", padding: "6px 16px", background: tint(T.danger, 8),
						borderBottom: "1px solid " + T.border1,
						fontSize: 12, lineHeight: "18px", color: T.danger
					}
				}, error) : null,

				// 主体：**从未发布** → 空态（不挂 iframe，别把 404 当文档画给用户）；
				// 有快照 → 原样挂 iframe。
				neverPublished ? React.createElement(MiniAppNotPublished, {
					t: t, icon: icon, busy: busy, onPublish: publish
				}) :
				// 主体：已发布快照占满剩余高度。这是一个「可以收缩且高度已解析」的
				// flex 子元素 —— 百分比高度的 iframe 在 auto-height 祖先下会塌成 0px，
				// 看起来正是这套布局要避免的那种白屏。
				React.createElement("div", {
					style: {
						position: "relative", flex: 1, minHeight: 0, width: "100%",
						overflow: "hidden", background: T.bgBase
					}
				},
					React.createElement("iframe", {
						key: mountKey,
						// `embed` 由调用方按需传 true（见下面 `props.embed === true`）：
						// 那时 src 上会多一个 `?embed=1`，宿主据此往正文里注入量高脚本。
						// 会话页签与右侧栏都不带 —— 它们的高度由布局给，不需要自报。
						src: cornerFrameUrl(app.miniapp_id, props.embed === true),
						sandbox: IFRAME_SANDBOX,
						title: app.name,
						// 要量高的那一面把它的 ref 交进来，用来认领"从这一个 iframe 发来的"
						// 量高消息（见 runnerHeightFromMessage）。面不传就不产生这个 ref。
						// 2026-09：**现在没有生产调用点传它**（原来传的是自绘浮窗，已退役）——
						// 但协议与这条 ref 通路都留着（见 runnerHeightFromMessage 的说明）。
						ref: props.onFrameRef,
						onLoad: onLoad,
						style: { display: "block", width: "100%", height: "100%", border: 0 }
					}),
					stalled && !dismissed ? React.createElement("div", {
						role: "status",
						style: {
							position: "absolute", left: 12, right: 12, bottom: 12, zIndex: 10,
							display: "flex", alignItems: "center", gap: 8, boxSizing: "border-box",
							borderRadius: 10, padding: "8px 12px",
							border: "1px solid " + T.border1, background: T.bgLayer1,
							boxShadow: "0 8px 24px rgba(0,0,0,0.14)"
						}
					},
						React.createElement("span", {
							style: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: "17px", color: T.text2 }
						}, t("frame.stalledHint")),
						React.createElement(HintButton, {
							icon: "refresh", label: t("actions.retry"),
							onClick: function () { setRetryToken(function (value) { return value + 1; }); }
						}),
						React.createElement(HintButton, { icon: "browser", label: t("actions.openInBrowser"), onClick: openExternally }),
						React.createElement("button", {
							type: "button",
							title: t("actions.dismissHint"), "aria-label": t("actions.dismissHint"),
							onClick: function () { setDismissed(true); },
							style: {
								display: "grid", placeItems: "center", width: 24, height: 24,
								flex: "0 0 auto", borderRadius: 8, border: 0,
								background: "transparent", cursor: "pointer", color: T.text2
							}
						}, React.createElement(Icon, { name: "close", size: 12 }))
					) : null
				)
			);
		}

		// ---------------------------------------------------------- 会话页签
		//
		// 「在本会话页签打开」的落点：会话头部那一排页签里的「小程序」。
		//
		// 它与另外三个浮层的区别是本质性的：**它是会话主体的一部分**，占满会话区宽度、
		// 和「会话」「轨迹」并列，会随着会话切换一起走；浮层是盖在界面上的东西。
		//
		// 身体复用同一个 RunnerView（`chrome: "compact"`），所以"同一个小程序在四个运行面上
		// 跑"（**面板 / 右侧栏 / 会话页签 / 右上浮窗**）是同一个组件、同一条沙箱串、
		// 同一个 `src=SERVE/…`，没有第二份 iframe。
		//
		// 口径提醒：`LAYOUT_PLACES` 是**五个**地方，第五个是**浏览器新页签** —— 它在 DSH 之外，
		// 只拿到同一个 `src`，**不跑 RunnerView**；所以"四个运行面一致"与"五个地方"不矛盾，
		// 说"四个"时指的就是上面那四个。

		/** 空态里那一列小程序的几何（简简单单一行一条，别做成卡片墙）。 */
		var SESSION_PICK_ROW_STYLE = {
			display: "flex", alignItems: "center", gap: 10, boxSizing: "border-box",
			padding: "10px 12px", borderRadius: 10,
			border: "1px solid " + T.border1, background: T.bgLayer1
		};

		/**
		 * 会话页签里的一格。
		 *
		 * 没选中时给的是**真能用的空态**：自己去 `/apps` 拉已发布的小程序，列成一行一条，
		 * 点「打开」就在这个页签里跑起来。「请去面板选一个」那种一句话空态是没有用的 ——
		 * 用户已经站在这个页签里了，他要的是就地选一个。
		 *
		 * 选中之后：本页签里跑的是 RunnerView；「关闭」只是把这一格放空（回到空态），
		 * 不离开页签 —— 页签是会话的头，用户随手就能切回来。
		 */
		// -------------------------------- DSH 原生右栏 tab 的正文（方案 B 的"并列"那一面）
		//
		// chrome 选 **"compact"**（与会话页签同一档），不是 "full" 也不是 "none"：
		//  * tab 条本身就是这一格的上边 —— 再画一条完整工具栏会和它叠成两条（"full" 排除）；
		//  * "none" 又会把「返回库页面 / 换语言 / 换地方」那一排全砍掉，而右栏里也需要一个出口；
		//  * "compact" 正好是"不画完整工具栏、但保留必要按钮"那一档，会话页签已经验证过它。
		//
		// 身体依旧是**同一个 `RunnerView`** —— 四个运行面一份实现，这条不变。
		function MiniAppRightbarPane(props) {
			var t = props.t;
			var catalog = useCatalog();
			var app = findCatalogApp(catalog, props.ui.get().appId);

			// 目录没被拉过就拉一次（与另外两个面同一条逻辑：它要把 appId 变成一条记录）。
			useEffect(function () {
				if (catalog.loaded === true || catalog.loading === true) return;
				void appCatalog.load(false);
			}, [catalog.loaded, catalog.loading]);

			if (app === null) {
				return React.createElement("div", {
					"data-dsh-miniapp-rightbar": "",
					role: "status",
					style: Object.assign({}, TEXT3, {
						flex: 1, minHeight: 0, display: "grid", placeItems: "center",
						padding: 24, fontSize: 12, lineHeight: "18px", textAlign: "center"
					})
				}, floatingBodyNote(t, catalog));
			}

			return React.createElement("div", {
				"data-dsh-miniapp-rightbar": "",
				style: { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, width: "100%", height: "100%" }
			},
				React.createElement(RunnerView, {
					t: t, app: app, chrome: "compact",
					onRefresh: function () { void appCatalog.load(true); },
					onPublished: function () { void appCatalog.load(true); },
					// 「关闭」= 关掉我们这一格；关不了（老 DSH / 没有服务）就什么都不做 ——
					// 不假装关掉了。
					onClose: function () {
						var sidebarRight = rightbarService(props.ctx);
						if (sidebarRight !== null && typeof sidebarRight.close === "function") {
							try { sidebarRight.close(RIGHTBAR_VIEW_ID); } catch (error) { /* 关不掉就算了 */ }
						}
					},
					layoutCurrent: "drawer",
					onSwitchLayout: function (place, appId) {
						switchLayout(place, appId, { t: t, ctx: props.ctx });
					}
				})
			);
		}

		function MiniAppSessionView(props) {
			var t = props.t;
			var sessionId = props.sessionId;
			var selected = useSessionView(sessionId);
			var catalog = useCatalog();
			var appId = selected.appId;
			var app = findCatalogApp(catalog, appId);

			// 目录没被拉过就拉一次。列表为空时它是空态要展示的东西，列表不为空时它是
			// "选中之后要把 appId 变成一条记录"的来源 —— 两种情况都需要它。
			useEffect(function () {
				if (catalog.loaded === true || catalog.loading === true) return;
				void appCatalog.load(false);
			}, [catalog.loaded, catalog.loading]);

			// 选中了并且目录里还找得到它：这一格就在跑它。
			//
			// 找 **不** 到（目录还没回来、或者那条小程序已经被删了）时落到下面的空态：
			// 目录回来之前它会显示"正在加载…"，之后会显示可选的列表 —— 用户随手就能
			// 换一个，而不是盯着一个永远转圈的空壳（那正是"选中态"最容易退化成的样子）。
			if (app !== null) {
				return React.createElement(RunnerView, {
					t: t, app: app, chrome: "compact",
					onRefresh: function () { void appCatalog.load(true); },
					onPublished: function () { void appCatalog.load(true); },
					// 「关闭」= 把这一格放空；若再没有会话用它，页签本身也会消失。
					onClose: function () { closeInSession(props.ctx, sessionId); },
					// 「切换布局」：这一版正站在**会话页签**上，所以 `layoutCurrent` 是
					// `"session"`，而那一枚点下去自己不会动（见 LayoutSwitchButton）。
					layoutCurrent: "session",
					onSwitchLayout: function (place, appId) {
						switchLayout(place, appId, { t: t, ctx: props.ctx });
					}
				});
			}

			var loading = catalog.loading === true || catalog.loaded !== true;
			var apps = catalog.apps;

			return React.createElement("div", {
				"data-dsh-miniapp-session-view": "",
				style: {
					display: "flex", flexDirection: "column", flex: 1, minHeight: 0,
					width: "100%", boxSizing: "border-box", overflowY: "auto",
					padding: "28px 24px", gap: 14
				}
			},
				React.createElement("div", {
					style: { fontSize: 14, fontWeight: 600, color: T.text1 }
				}, t("view.pick")),
				catalog.error !== null ? React.createElement("div", {
					role: "status",
					style: { fontSize: 12, lineHeight: "18px", color: T.danger }
				}, t("errors.loadListFailed", { message: catalog.error })) : null,
				loading && apps.length === 0
					? React.createElement("div", { style: { fontSize: 13, color: T.text2 } }, t("list.loading"))
					: apps.length === 0
						? React.createElement("div", {
							style: Object.assign({}, TEXT3, { fontSize: 13, lineHeight: "19px", maxWidth: 520 })
						}, t("view.empty"))
						: React.createElement("div", {
							style: {
								display: "flex", flexDirection: "column", gap: 8,
								maxWidth: 520, width: "100%", boxSizing: "border-box"
							}
						}, apps.map(function (entry) {
							var icon = (entry.icon || "").trim();
							return React.createElement("div", {
								key: entry.miniapp_id, style: SESSION_PICK_ROW_STYLE
							},
								React.createElement("span", {
									"aria-hidden": "true",
									style: {
										display: "grid", placeItems: "center", width: 28, height: 28,
										flex: "0 0 auto", borderRadius: 8, background: T.fill,
										fontSize: 15, lineHeight: 1, color: T.brand
									}
								}, icon.length > 0 ? icon : React.createElement(Icon, { name: "app", size: 15 })),
								React.createElement("span", {
									style: {
										flex: "1 1 auto", minWidth: 0, overflow: "hidden",
										textOverflow: "ellipsis", whiteSpace: "nowrap",
										fontSize: 13, color: T.text1
									}
								}, entry.name),
								React.createElement("button", {
									type: "button",
									title: t("actions.open") + ": " + entry.name,
									"aria-label": t("actions.open") + ": " + entry.name,
									// 点一下就在这个页签里跑起来 —— 不再多问一句。
									onClick: function () { sessionViewStore.open(sessionId, entry.miniapp_id); },
									style: CARD_OPEN_STYLE
								},
									React.createElement("span", null, t("actions.open")),
									React.createElement(Icon, { name: "right", size: 12 })
								)
							);
						}))
			);
		}

		// ------------------------------------------------------------ 导入对话框

		function ImportDialog(props) {
			var t = props.t;
			var [html, setHtml] = useState("");
			var [fileName, setFileName] = useState(null);
			var [report, setReport] = useState(null);
			var [fixes, setFixes] = useState([]);
			var [busy, setBusy] = useState(false);
			var [error, setError] = useState(null);
			var fileRef = useRef(null);

			var validate = useCallback(async function (candidate) {
				setBusy(true);
				setError(null);
				try {
					var data = await callApi("/validate", { method: "POST", body: { html: candidate } });
					setReport(data);
					setFixes(data.applied_fixes || []);
				} catch (validateError) {
					setError(t("import.errors.validateFailed", { message: validateError.message }));
				} finally {
					setBusy(false);
				}
			}, [t]);

			var accept = useCallback(async function () {
				setBusy(true);
				setError(null);
				try {
					var data = await callApi("/import", {
						method: "POST",
						body: { html: html, file_name: fileName || undefined }
					});
					props.onImported(data.app, data.applied_fixes || []);
				} catch (importError) {
					var payload = importError.payload;
					if (payload && payload.data && payload.data.report) {
						// 400 的响应体里仍然带着完整报告 —— 让用户留在同一套解释模型里。
						setReport(payload.data.report);
						setFixes(payload.data.applied_fixes || []);
						setError(t("import.errors.blocked"));
					} else {
						setError(t("import.errors.importFailed", { message: importError.message }));
					}
				} finally {
					setBusy(false);
				}
			}, [fileName, html, props, t]);

			// 「用会话改造」在 DSH 里没有直连的建会话 API，因此退化成一个可以交给
			// 任意会话的提示词：复制它，粘给 AI，让它产出单文件版本再导回来。
			var copyConversionPrompt = useCallback(async function () {
				var fatal = (report && report.findings ? report.findings : [])
					.filter(function (finding) { return finding.severity === "fatal"; })
					.map(function (finding) { return "- " + finding.rule_id + (finding.detail ? "：" + finding.detail : ""); })
					.join("\n");
				var prompt = t("import.convertPrompt", { findings: fatal });
				try {
					await navigator.clipboard.writeText(prompt);
					props.onNotice(t("import.convertCopied"));
				} catch (copyError) {
					setError(t("import.errors.copyFailed", { message: String(copyError && copyError.message || copyError) }));
				}
			}, [props, report, t]);

			var onPickFile = useCallback(async function (event) {
				var file = event.target.files && event.target.files[0];
				// 读取之后再清空 input，否则连选同一个文件不会再触发 change。
				if (!file) return;
				try {
					var text = await file.text();
					setHtml(text);
					setFileName(file.name);
					setReport(null);
					setFixes([]);
					await validate(text);
				} catch (readError) {
					setError(t("import.errors.readFailed", { message: String(readError && readError.message || readError) }));
				} finally {
					event.target.value = "";
				}
			}, [t, validate]);

			var groups = useMemo(function () {
				if (!report || !report.findings) return [];
				var order = ["fatal", "autofix", "warning"];
				var out = order.map(function (severity) {
					return { severity: severity, items: report.findings.filter(function (f) { return f.severity === severity; }) };
				}).filter(function (group) { return group.items.length > 0; });
				return out;
			}, [report]);

			var blocked = report ? report.blocked : false;

			return React.createElement("div", {
				style: {
					position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center",
					background: "rgba(0,0,0,0.42)", pointerEvents: "auto"
				},
				onClick: function (event) { if (event.target === event.currentTarget) props.onClose(); }
			},
				React.createElement("div", {
					style: {
						width: "min(720px, 92vw)", maxHeight: "86vh", display: "flex", flexDirection: "column",
						gap: 12, padding: 20, borderRadius: 14, border: "1px solid " + T.border2,
						background: T.bgLayer1, overflowY: "auto", boxSizing: "border-box"
					}
				},
					React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
						React.createElement("div", { style: { fontSize: 15, fontWeight: 600, color: T.text1 } }, t("import.title")),
						React.createElement("button", {
							type: "button", style: INLINE_ICON_BUTTON,
							"aria-label": t("actions.close"), onClick: props.onClose
						}, React.createElement(Icon, { name: "close", size: 14 }))
					),
					React.createElement("div", { style: { fontSize: 12, lineHeight: "18px", color: T.text2 } }, t("import.intro")),
					React.createElement("textarea", {
						style: Object.assign({}, FIELD_STYLE, { minHeight: 160, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", resize: "vertical" }),
						placeholder: t("import.pastePlaceholder"),
						value: html,
						onChange: function (event) { setHtml(event.target.value); setReport(null); setFixes([]); }
					}),
					React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
						React.createElement("input", {
							ref: fileRef, type: "file", accept: ".html,.htm,text/html",
							style: { display: "none" }, onChange: onPickFile
						}),
						React.createElement("button", {
							type: "button",
							style: Object.assign({}, INLINE_GHOST, busy ? DISABLED_STYLE : null), disabled: busy,
							onClick: function () { if (fileRef.current) fileRef.current.click(); }
						}, t("import.pickFile")),
						React.createElement("span", { style: { fontSize: 12, color: T.text2 } },
							fileName ? t("import.sourceFile", { name: fileName, size: formatBytes(new Blob([html]).size) }) : t("import.pickFileHint")),
						React.createElement("div", { style: { flex: 1 } }),
						React.createElement("button", {
							type: "button", style: Object.assign({}, INLINE_GHOST, (busy || html.trim().length === 0) ? DISABLED_STYLE : null), disabled: busy || html.trim().length === 0,
							onClick: function () { validate(html); }
						}, busy ? t("import.validating") : t("import.validate"))
					),
					error ? React.createElement("div", {
						style: { fontSize: 13, color: T.danger, padding: "8px 12px", border: "1px solid " + T.danger, borderRadius: 8 }
					}, error) : null,
					report && groups.length === 0
						? React.createElement("div", {
							style: { fontSize: 13, color: T.success, padding: "8px 12px", border: "1px solid " + T.success, borderRadius: 8 }
						}, t("import.clean"))
						: null,
					groups.map(function (group) {
						var headerKey = "import.severity." + group.severity;
						var tone = group.severity === "fatal" ? T.danger : group.severity === "autofix" ? T.brand : T.warn;
						return React.createElement("div", { key: group.severity, style: { display: "flex", flexDirection: "column", gap: 6 } },
							React.createElement("div", { style: { fontSize: 13, fontWeight: 600, color: tone } },
								t(headerKey, { total: group.items.length })),
							group.items.map(function (finding, index) {
								var copyKey = ruleCopyKey(finding.rule_id);
								return React.createElement("div", {
									key: finding.rule_id + index,
									style: {
										display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px",
										borderRadius: 8, background: T.fill, border: "1px solid " + T.border1
									}
								},
									React.createElement("div", { style: { fontSize: 13, color: T.text1 } }, t("import.rules." + copyKey + ".title", { ruleId: finding.rule_id })),
									finding.detail ? React.createElement("code", {
										style: { fontSize: 12, color: T.text2, wordBreak: "break-all" }
									}, finding.detail) : null,
									React.createElement("div", { style: { fontSize: 12, lineHeight: "18px", color: T.text2 } },
										t("import.rules." + copyKey + ".fix", { ruleId: finding.rule_id, detail: finding.detail || "" }))
								);
							})
						);
					}),
					fixes.length > 0
						? React.createElement("div", { style: { fontSize: 12, color: T.text2 } },
							t("import.appliedFixes", { items: fixes.join("、") }))
						: null,
					React.createElement("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" } },
						blocked
							? React.createElement("button", { type: "button", style: Object.assign({}, INLINE_GHOST, busy ? DISABLED_STYLE : null), disabled: busy, onClick: copyConversionPrompt }, t("import.convert"))
							: null,
						React.createElement("button", { type: "button", style: INLINE_GHOST, onClick: props.onClose }, t("actions.cancel")),
						React.createElement("button", {
							type: "button",
							style: Object.assign({}, INLINE_PRIMARY, (busy || report === null || blocked) ? DISABLED_STYLE : null),
							disabled: busy || report === null || blocked,
							onClick: accept
						}, t("import.action"))
					),
					blocked
						? React.createElement("div", { style: { fontSize: 12, lineHeight: "18px", color: T.text2 } }, t("import.convertHint"))
						: null
				)
			);
		}

		// ---------------------------------------------------------- 重命名 / 确认

		function PromptDialog(props) {
			var t = props.t;
			var [value, setValue] = useState(props.initialValue || "");
			useEffect(function () { setValue(props.initialValue || ""); }, [props.initialValue]);
			return React.createElement("div", {
				style: {
					position: "fixed", inset: 0, zIndex: 70, display: "grid", placeItems: "center",
					background: "rgba(0,0,0,0.42)", pointerEvents: "auto"
				}
			},
				React.createElement("div", {
					style: {
						width: "min(420px, 92vw)", display: "flex", flexDirection: "column", gap: 12,
						padding: 20, borderRadius: 14, border: "1px solid " + T.border2, background: T.bgLayer1
					}
				},
					React.createElement("div", { style: { fontSize: 15, fontWeight: 600, color: T.text1 } }, props.title),
					props.danger
						? React.createElement("div", { style: { fontSize: 13, lineHeight: "20px", color: T.text2 } }, props.message)
						: React.createElement("input", {
							style: FIELD_STYLE, value: value, autoFocus: true,
							placeholder: props.placeholder,
							onChange: function (event) { setValue(event.target.value); }
						}),
					React.createElement("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
						React.createElement("button", { type: "button", style: INLINE_GHOST, onClick: props.onCancel }, t("actions.cancel")),
						React.createElement("button", {
							type: "button",
							style: props.danger ? INLINE_DANGER : INLINE_PRIMARY,
							disabled: !props.danger && value.trim().length === 0,
							onClick: function () { props.onConfirm(props.danger ? undefined : value.trim()); }
						}, props.confirmLabel)
					)
				)
			);
		}

		// ------------------------------------------------------------ 浮层主体
		//
		// 库视图与运行视图共用一个面板。面板本身不带内边距：库视图自己要 20px，
		// 运行视图的工具栏必须贴边（原版运行页就是一条贴边的 52px 工具栏）。

		function MiniAppOverlay(props) {
			var t = props.t;
			var ui = props.ui;
			var [open, setOpen] = useState(ui.get().open);
			var [apps, setApps] = useState([]);
			var [loading, setLoading] = useState(false);
			var [error, setError] = useState(null);
			var [running, setRunning] = useState(null);
			// 「跑到哪一个」这条命令的**待结算**那一份。
			//
			// 为什么是两步（这里收命令、下面那个 effect 结算）：命令带着一个 appId 进来，
			// 而"appId → 一条记录"要在 `apps` 里查。`apps` 是一份会变的局部状态，所以
			// 解析只能放在 effect 里 —— 放进 `setApps` 的 updater 里就是"在 updater 里
			// 调另一个 setState"，updater 应当是纯的（同一个 updater 可能被 React 调两遍，
			// 于是那次 setRunning 也会发生两遍，或者干脆被丢弃）。
			var [pendingRunId, setPendingRunId] = useState(null);
			var [importing, setImporting] = useState(false);
			var [renaming, setRenaming] = useState(null);
			var [deleting, setDeleting] = useState(null);
			var [notice, setNotice] = useState(null);
			var mounted = useRef(true);

			useEffect(function () {
				mounted.current = true;
				return function () { mounted.current = false; };
			}, []);

			useEffect(function () {
				/**
				 * 读一次当前那份 ui：跟着「打开/关闭」走，并且把 `runningId` 那条命令收下。
				 *
				 * `runningId` 是**一次性命令**，不是一份状态：读走就立刻清掉。
				 *  * 留着它会坏两件事：之后任何一次 ui 变化（弹一条提示、切别的面、
				 *    目录刷新顺手写回状态）都会重放这条命令，把用户从库页面重新拽回运行页；
				 *    而且"再切回同一个小程序"会变成一次**没有变化**的写入，命令再也发不出来。
				 *  * 清空会同步重入一次这个订阅（值为 null，直接返回），到此为止，不会打转。
				 */
				var consume = function () {
					var next = ui.get();
					setOpen(next.open);
					if (next.runningId === null) return;
					var target = next.runningId;
					ui.set({ runningId: null });
					setPendingRunId(target);
				};
				// **挂载时先读一次**，不能只订阅"之后的变化"：这条命令完全可能是
				// 在**这个组件还没挂载的时候**写进来的 —— 比如用户站在并列那一面里
				// （那一面由 DSH 的右栏画，不由这个渲染口画），点了「换到全屏面板」：
				// 那一刻全屏浮层根本还没渲染，只订阅就会把命令丢掉 ——
				// 面板确实打开了，却停在库页面，而不是用户要的那一个小程序。
				consume();
				return ui.subscribe(consume);
			}, [ui]);

			// 结算那条命令：目录里有这一条就跑到它上面去。
			//
			// 目录还没到位时**什么都不做** —— `apps` 一变这个 effect 就会再跑一遍，
			// 而浮层打开时那次 `refresh()` 正是带来变化的那一下。这一条是必要的：
			// 从别的面切回全屏面板时，面板那份 `apps` 往往是空的（列表是它自己的局部
			// 状态），当次渲染根本解析不出记录。
			useEffect(function () {
				if (pendingRunId === null) return;
				var found = apps.filter(function (app) { return app.miniapp_id === pendingRunId; })[0];
				if (found === undefined) return;
				setPendingRunId(null);
				setRunning(found);
			}, [apps, pendingRunId]);

			var refresh = useCallback(async function () {
				setLoading(true);
				try {
					var list = await callApi("/apps");
					if (!mounted.current) return;
					setApps(list);
					setError(null);
					setRunning(function (current) {
						if (current === null) return null;
						return list.filter(function (app) { return app.miniapp_id === current.miniapp_id; })[0] || null;
					});
				} catch (listError) {
					if (mounted.current) setError(listError.message);
				} finally {
					if (mounted.current) setLoading(false);
				}
			}, []);

			// 只在浮层打开时拉取；关闭时不做任何请求。
			useEffect(function () {
				if (open) void refresh();
			}, [open, refresh]);

			useEffect(function () {
				if (!open) return undefined;
				function onKeyDown(event) {
					if (event.key !== "Escape") return;
					if (importing || renaming || deleting) return;
					if (running !== null) setRunning(null);
					else ui.set({ open: false });
				}
				window.addEventListener("keydown", onKeyDown);
				return function () { window.removeEventListener("keydown", onKeyDown); };
			}, [deleting, importing, open, renaming, running, ui]);

			var showNotice = useCallback(function (message) {
				setNotice(message);
				window.setTimeout(function () { if (mounted.current) setNotice(null); }, 3200);
			}, []);

			var copyText = useCallback(async function (text, okMessage, failKey) {
				try {
					await navigator.clipboard.writeText(text);
					showNotice(okMessage);
				} catch (copyError) {
					showNotice(t(failKey, { message: String((copyError && copyError.message) || copyError) }));
				}
			}, [showNotice, t]);

			// 「继续迭代」：物化工作副本，取回源码绝对路径，再把一段可直接粘贴的
			// 指令放进剪贴板。DSH 插件没有建会话的直连 API，粘贴是唯一不骗人的做法。
			var iterate = useCallback(async function (app) {
				try {
					var data = await callApi("/apps/" + app.miniapp_id + "/iterate", { method: "POST" });
					await copyText(
						t("iterate.prompt", { name: app.name, id: app.miniapp_id, path: data.source_path }),
						t("iterate.copied"),
						"iterate.failed"
					);
				} catch (iterateError) {
					showNotice(t("iterate.failed", { message: iterateError.message }));
				}
			}, [copyText, showNotice, t]);

			/**
			 * 「创建小程序」：关浮层 → 开一个新的空白会话 → 在那里预置 `/create-miniapp`。
			 *
			 * 原实现是"复制一段创建提示词到剪贴板，让用户自己找地方粘"（`create.prompt`）。
			 * 那是在插件还没有技能的时候唯一的诚实做法；现在宿主半边用
			 * `ctx.skills.register` 注册了 `create-miniapp`，输入框里那句
			 * `/create-miniapp` 会被 DSH 的 `/` 触发器按当前会话的技能 lexicon
			 * 装饰成技能标签 —— 所以这一步不再需要用户手工粘贴，直接把人送到那里去。
			 *
			 * 顺序是**关浮层 → 置位 → 开新会话**，三步都有理由：
			 *  * 先关：浮层是 `position: fixed` 的全屏面板，不关掉的话它会盖住刚跳过去的会话；
			 *  * 再置位：`startSession()` 可能复用当前这个空白会话（见 MiniAppCreateIntent），
			 *    那时不会重新挂载任何东西，只有**已经挂载**的消费者才接得住这次意图；
			 *  * 最后才开：任何在第 2 步之后到达的 composer 都能看到这份意图。
			 *
			 * 降级：更老的 DSH 上没有 `uiWorkspace`（客户端 inject 刻意只有
			 * `['slots','locale']`，新服务一律按可选依赖取）。那时**不假装成功** ——
			 * 回到原来那条复制剪贴板的路，并把结果如实说出来。
			 *
			 * 保留降级**不只是**为了"老 DSH"：`uiWorkspace` 是 DSH 自己的客户端服务
			 * （侧栏 / 工作区 / agent-preset 共用），**不是为第三方冻结的契约** ——
			 * 它改名或换形状都不算违约。所以这条降级是这个依赖的**常备出口**，
			 * 不是历史包袱：看到它能跑就把降级删掉，等于把一次可预期的漂移
			 * 重新变回"用户点了没反应"。
			 */
			var create = useCallback(function () {
				var ctx = props.ctx;
				var uiWorkspace = ctx === undefined || ctx === null || typeof ctx.get !== "function"
					? undefined
					: ctx.get("uiWorkspace");
				if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.startSession !== "function") {
					return copyText(t("create.prompt"), t("create.copied"), "errors.actionFailed");
				}
				ui.set({ open: false });
				createIntent.stage();
				uiWorkspace.startSession();
				return undefined;
			}, [copyText, props.ctx, t]);

			var confirmRename = useCallback(async function (value) {
				var target = renaming;
				setRenaming(null);
				if (target === null || value === undefined) return;
				try {
					await callApi("/apps/" + target.miniapp_id, { method: "POST", body: { name: value } });
					await refresh();
					showNotice(t("rename.success"));
				} catch (renameError) {
					showNotice(t("errors.actionFailed", { message: renameError.message }));
				}
			}, [refresh, renaming, showNotice, t]);

			var confirmDelete = useCallback(async function () {
				var target = deleting;
				setDeleting(null);
				if (target === null) return;
				try {
					await callApi("/apps/" + target.miniapp_id, { method: "DELETE" });
					if (running !== null && running.miniapp_id === target.miniapp_id) setRunning(null);
					await refresh();
					showNotice(t("delete.success"));
				} catch (deleteError) {
					showNotice(t("errors.actionFailed", { message: deleteError.message }));
				}
			}, [deleting, refresh, running, showNotice, t]);

			/**
			 * 「切换布局」那一排按钮真正要做的事 —— 直接交给 `switchLayout`。
			 *
			 * 这里**不再**自己实现「在本会话页签打开」：那句话现在活在 `switchLayout` 里，
			 * 四个头共用同一份。以前那个 `placeInSession` 会把"拿不到会话"说在浮层内部的
			 * notice 上（浮层一关就看不见），现在走 `ui.toast`，任何面里都看得见。
			 */
			var onSwitchLayout = useCallback(function (place, appId) {
				switchLayout(place, appId, { t: t, ctx: props.ctx });
			}, [props.ctx, t]);

			if (!open) return null;

			var busyDialog = importing || renaming !== null || deleting !== null;

			return React.createElement("div", {
				style: {
					position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center",
					background: "rgba(0,0,0,0.36)", pointerEvents: "auto"
				},
				onClick: function (event) {
					if (event.target === event.currentTarget && !busyDialog) ui.set({ open: false });
				}
			},
				React.createElement("div", {
					style: {
						position: "relative",
						width: "min(1180px, 94vw)", height: "min(860px, 90vh)",
						display: "flex", flexDirection: "column", boxSizing: "border-box",
						borderRadius: 16, border: "1px solid " + T.border2, background: T.bgLayer1,
						boxShadow: "0 24px 64px rgba(0,0,0,0.32)", overflow: "hidden",
						// 运行视图的工具栏要贴边；库视图自己给 20px。
						padding: running !== null ? 0 : 20
					}
				},
					running !== null
						? React.createElement(RunnerView, {
							t: t, app: running,
							onBack: function () { setRunning(null); },
							onRefresh: refresh,
							onPublished: refresh,
							onIterate: iterate,
							onRename: setRenaming,
							onDelete: setDeleting,
							onClose: function () { ui.set({ open: false }); },
							// 「换个地方」：五枚按钮共用 `switchLayout`。面板这一版的
							// `layoutCurrent` 恒为 `"panel"` —— 这一段就是全屏面板本身。
							layoutCurrent: "panel",
							onSwitchLayout: onSwitchLayout
						})
						: React.createElement(LibraryView, {
							t: t, apps: apps, loading: loading, error: error,
							onRefresh: refresh,
							onImport: function () { setImporting(true); },
							onCreate: create,
							onClose: function () { ui.set({ open: false }); },
							onOpen: function (app) { setRunning(app); },
							onIterate: iterate,
							onRename: setRenaming,
							onDelete: setDeleting
						}),

					importing ? React.createElement(ImportDialog, {
						t: t,
						onClose: function () { setImporting(false); },
						onNotice: showNotice,
						onImported: function (app, appliedFixes) {
							setImporting(false);
							showNotice(appliedFixes.length > 0
								? t("import.successWithFixes", { name: app.name, items: appliedFixes.join("、") })
								: t("import.success", { name: app.name }));
							void refresh();
						}
					}) : null,

					renaming !== null ? React.createElement(PromptDialog, {
						t: t, title: t("rename.title"), initialValue: renaming.name,
						placeholder: t("rename.placeholder"), confirmLabel: t("actions.confirm"),
						onCancel: function () { setRenaming(null); },
						onConfirm: confirmRename
					}) : null,

					deleting !== null ? React.createElement(PromptDialog, {
						t: t, title: t("delete.confirmTitle"), danger: true,
						message: t("delete.confirmContent", { name: deleting.name }),
						confirmLabel: t("actions.delete"),
						onCancel: function () { setDeleting(null); },
						onConfirm: confirmDelete
					}) : null,

					notice !== null ? React.createElement("div", {
						style: {
							position: "absolute", left: "50%", bottom: 28, transform: "translateX(-50%)",
							padding: "8px 16px", borderRadius: 999, background: T.bgLayer1,
							border: "1px solid " + T.border2, fontSize: 12, color: T.text1,
							boxShadow: "0 8px 24px rgba(0,0,0,0.18)", pointerEvents: "none"
						}
					}, notice) : null
				)
			);
		}

		// ------------------------------------------------- 贴边那两面的"地基换人"记
		//
		// 这里原来有一个 449 行的 `MiniAppFloatingRunner`（同一组件两个 `variant`：右侧栏
		// 那一列 + 会话右上角那块 380×420 的有界浮窗），外加 198 行自绘几何、一个
		// `ResizeGrip`、12 个导出与两个几何状态键。**2026-09 整体退役**，理由与替代如下：
		//
		//  * **并列**（原来 `variant: "column"`，自己画一列假装抽屉）→ 改成登记
		//    `sidebar.right.pane.tab` 那一格，由 DSH 的右栏渲染（`MiniAppRightbarPane`）。
		//    原来那一路从来没能好好工作过：更早的版本去接管幽灵座位 `details` +
		//    不存在的 `layout.openDetails()`，`ctx.slots.inject` 对不存在的名字**静默等待**，
		//    于是那一面连一次渲染机会都没有（见 `test/seat-contract.test.mjs` 的已知缺口账目）。
		//  * **悬浮**（原来 `variant: "corner"`）→ 改成求 `sidebarRight.float()` 并**读回确认**
		//    （`floatRightbarPane`）。位置、尺寸、拖动、缩放、夹取、层级全部归 DSH ——
		//    窗框是它的，我们就没有"我们的几何"可言，所以那 9 个纯函数与它们的常量一起删了。
		//
		// **两条取舍（有意，不是省事）**：
		//  1. 老 DSH（没有 `sidebarRight` 服务）上这两面**如实失败**：返回 false + 一句
		//     `open.rightbarUnavailable`，而不是退回自绘窗口。"两套并存"正是这次要拆掉的东西，
		//     留着它意味着同一份需求有两份实现、且只有一份在被维护。
		//  2. **不按名字批量删**：`cornerFrameUrl`（serve URL 拼接，`openInBrowser` 与浏览器
		//     那一面在用）与 `runnerHeightFromMessage`（`?embed=1` 量高协议的客户端一半，
		//     宿主半边仍在注入量高脚本）名字里都带 `corner` / `runner`，但它们**不是**自绘几何。
		//     删错任一个都只会表现为某个不相关的面"功能消失"。
		//
		// z 轴：全屏浮层是"要看完再回来"的模态，两个贴边面（右栏那一列 / 悬浮窗）
		// 是"边聊边用"的旁挂件 —— 后者现在由 DSH 自己的悬浮/停靠能力画，层级也归它管；
		// 对话框（60/70）要压在全屏浮层之上。

		/**
		 * 那句跨浮层提示（toast）的层级。
		 *
		 * **它必须压在全屏浮层之上**（50），因为它已经不只是"浮层关掉之后才看的回执"了：
		 * 「切换布局」把"拿不到当前会话"这类话也交给它，而那些情况恰恰发生在**浮层还开着**
		 * 的时候（取不到会话时故意不关浮层 —— 关掉等于把用户扔到一个什么都没发生的地方）。
		 * 还压在 60/70 那两个对话框之下：提示不该盖住用户正在填的表单。
		 */
		var TOAST_Z_INDEX = 55;
		// 这里原来有一整组「右上角浮窗」的常量（`CORNER_WIDTH` / `CORNER_HEIGHT` /
		// `CORNER_GAP` / `CORNER_MIN_*` / `CORNER_AUTO_*`，以及层级 `FLOATING_Z_INDEX`）。
		// 2026-09 退役自绘浮窗时一并删掉：**我们不再画那个窗口** —— 尺寸、位置、夹取、
		// 拖拽、缩放手柄全部交给 DSH 自己的悬浮能力（`floatRightbarPane` →
		// `sidebarRight.float()`）。DSH 若答应浮起来，画出来的是它的窗口，
		// 这里也就没有"我们的几何"可言（老 DSH 上如实失败，见 switchLayout 的 corner 分支）。
		/**
		 * 浮窗 iframe 的**嵌入模式**查询参数。
		 *
		 * 只有浮窗那一版 iframe 带它（见 cornerFrameUrl）。宿主半边（lib/index.js）
		 * 看到 `embed=1` 才往直出的正文里追加一段量高脚本 —— 这就是"默认自适应高度"
		 * 的全部机关：父页面读不到沙箱 iframe 的文档（没有 allow-same-origin），
		 * 只能让**文档自己**把高度 postMessage 出来。
		 *
		 * 名字必须与宿主那半边的 EMBED_QUERY 逐字一致，client.test.mjs 里有一条
		 * 把两侧字符串钉在一起的测试 —— 它们一旦漂移，自适应高度会**静默失效**
		 * （消息永远不来，退回固定高度，不报任何错）。
		 */
		var EMBED_QUERY = "embed=1";
		/**
		 * 运行页量高的 postMessage 协议类型。
		 *
		 * 与 `PREVIEW_MESSAGE_TYPE` **刻意不同**：`message` 事件是整页共享的，
		 * 两套协议共用一个类型名，模板预览那次注入的脚本（量的是预览文档）与运行页
		 * 这次注入的脚本（量的是运行文档）就会互相认领对方的消息 ——
		 * 轻则按 480 逻辑宽下的模板高度跳一下，重则预览卡片按整窗高度撑满。
		 * 前缀 `dsh-miniapp:` 是同样的理由：页面上还有 DSH 自己和别的插件在发消息。
		 */
		var RUNNER_HEIGHT_MESSAGE_TYPE = "dsh-miniapp:runner-height";

		/**
		 * 运行页 iframe 的 `src`。
		 *
		 * ⚠️ **名字里的 `corner` 是历史遗留，它跟自绘浮窗没关系**：这里拼的是
		 * `SERVE/<id>` 这条 serve 直出地址，`openInBrowser`（浏览器新页签那一面）
		 * 与 `RunnerView` 都用它。按名字批量删会当场把这两个不相关的面弄坏，
		 * 而且是"看起来像功能消失"的那种坏法。测试里有一条专门钉着它。
		 *
		 * `embed` 为真时追加 `?embed=1`，宿主半边看到它才往正文里注入量高脚本。
		 * **只有"要自报高度"的那一面才传 embed**：右栏与会话页签是布局里的真列，
		 * 高度由布局给，再自报一个只会和列打架；模板预览走的是另一条 `srcDoc` 通道。
		 */
		function cornerFrameUrl(appId, embed) {
			var base = SERVE + "/" + encodeURIComponent(appId);
			return embed === true ? base + "?" + EMBED_QUERY : base;
		}

		/**
		 * 从一条 `message` 事件里取出运行文档自报的高度；认不出来返回 0。
		 *
		 * 认领与校验的写法与 `previewHeightFromMessage` 逐条对齐（那边写清了为什么
		 * **必须**用 `event.source` 认领：沙箱没有 allow-same-origin，文档的源是不透明
		 * 的，它发出的消息 `origin` 一律是字符串 `"null"`，页面上任何别的 iframe
		 * 发来的诚实消息也长这样，靠 origin 判断等于没判断；而 `event.source`
		 * 是那个窗口对象本身，第三方代码伪造不出另一个窗口的引用）。
		 *
		 * 与预览那版的**唯一**区别是协议类型不同 —— 两套协议必须互不认领。
		 *
		 * 高度只认有限的、正的**数字**：`"1e999"` 这种字符串、NaN、Infinity、
		 * 负数一律丢掉，否则窗口会被撑到屏幕之外。
		 *
		 * ⚠️ **名字里的 `runner` 同样是历史遗留**（原来服务的是自绘浮窗，已退役）。
		 * 它是 `?embed=1` 这条量高协议的**客户端一半**：宿主半边仍在注入量高脚本，
		 * 所以它必须留着 —— 跟着它一起留的还有它的测试（"两个名字诱饵"里的另一个）。
		 */
		function runnerHeightFromMessage(event, frameWindow) {
			if (event === null || event === undefined || typeof event !== "object") return 0;
			if (frameWindow === null || frameWindow === undefined) return 0;
			if (event.source !== frameWindow) return 0;
			var data = event.data;
			if (data === null || typeof data !== "object") return 0;
			if (data.type !== RUNNER_HEIGHT_MESSAGE_TYPE) return 0;
			var height = data.height;
			if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return 0;
			return Math.ceil(height);
		}

		/**
		 * 量会话区滚动容器的 rect；量不到返回 null。
		 *
		 * 用 `document.querySelector` 而不是"从自己的节点往上 closest"：模板面板能用
		 * `closest` 是因为它长在 composer 座位里、本来就在会话区内部；而浮窗渲染在
		 * `shell.overlay` 那一层，**根本不在会话区里**（这正是它能浮着的原因），
		 * `closest` 从前者的节点出发永远返回 null。
		 *
		 * 页面上会话区只有一份（会话主体一次只挂一个），所以这个选择器是唯一的。
		 */
		function measureConversationRect() {
			try {
				if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
				var node = document.querySelector("[data-conversation-scroll]");
				if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return null;
				return node.getBoundingClientRect();
			} catch (error) {
				return null;
			}
		}

		/** 读视口尺寸；读不到给 undefined（调用方据此跳过"夹在视口内"那一步）。 */
		function viewportSize() {
			if (typeof window === "undefined") return { width: undefined, height: undefined };
			return {
				width: Number.isFinite(window.innerWidth) ? window.innerWidth : undefined,
				height: Number.isFinite(window.innerHeight) ? window.innerHeight : undefined
			};
		}

		/** 各运行面里那颗小程序不存在或还没到位时，身体上那一行小字。 */
		function floatingBodyNote(t, catalog) {
			if (catalog.error !== null) return t("errors.loadListFailed", { message: catalog.error });
			if (catalog.loaded !== true || catalog.loading === true) return t("list.loading");
			return t("open.missing");
		}

		/**
		 * `shell.overlay` 座位上的那个组件：这里画**全屏浮层**与 toast。
		 *
		 * 2026-09 之前它画三样互斥的东西（全屏浮层 / 右侧抽屉 / 右上浮窗），所以叫
		 * "唯一的那一个"。后两面退役（各自交给 DSH 原生能力）之后，这一层只剩全屏浮层；
		 * 之所以那三个开关的互斥判决**没有一起删**：`ui` 里 `mode` 是单一真相，
		 * 判决写在状态层（见 `createUiState`），渲染层只是照它画 —— 而"切到并列/悬浮
		 * 时顺手关掉面板"这条语义仍然成立（见 `switchLayout`）。
		 *
		 * toast 挂在最外层：它必须在**浮层关掉之后**仍然看得见 —— 「已放到本会话页签」
		 * 那条提示正是"关掉浮层、让用户去看上方页签"时才出现的。
		 */
		function MiniAppOverlaySeat(props) {
			var ui = props.ui;
			var [state, setState] = useState(ui.get());

			useEffect(function () {
				setState(ui.get());
				return ui.subscribe(function () { setState(ui.get()); });
			}, [ui]);

			useEffect(function () {
				if (state.toast === null) return undefined;
				if (typeof window === "undefined" || typeof window.setTimeout !== "function") return undefined;
				var handle = window.setTimeout(function () { ui.set({ toast: null }); }, TOAST_MS);
				return function () { window.clearTimeout(handle); };
			}, [state.toast, ui]);

			// 右侧栏**不是**这里渲染的：它是 DSH 自己那一列（`rightbar`），我们只是让它把我们
			// 那一格 tab 开出来 / 收回去（方案 B 的"并列"那一面）。
			//
			// 这里**不再有**"接管 `details`、盖住工具详情"那套 —— 那条路在 0.1.5 上根本不存在
			// （`details` 是幽灵名、`layout.openDetails` 也不存在，见 docs 的座位审计）。
			// 现在两边都是**读回判定**：开完读一次、关完读一次，没做到就不当成功。
			useEffect(function () {
				if (state.drawer === true && state.drawerId !== null) openRightbarPane(props.ctx);
				else closeRightbarPane(props.ctx);
				// 卸载时把那一格收回去（用户切走时不该留一个空壳占着右栏）。
				return function () { closeRightbarPane(props.ctx); };
			}, [state.drawer, state.drawerId, props.ctx]);

			// **悬浮那一面不在这里渲染**：它由 DSH 自己的悬浮能力画（`sidebarRight.float()`），
			// 我们这个座位只管"让它浮起来"那一步的读回确认（见 switchLayout 的 corner 分支）。
			// 2026-09 之前这里是"`state.corner` 为真就画我们自己的 `MiniAppFloatingRunner`"，
			// 自绘那一套退役后这一支没了 —— 留着它只会画出一个 DSH 已经在画的重复窗口。
			//
			// 于是这个座位现在只画两个东西：全屏浮层（自己判 `open`，没打开返回 null）与 toast。
			var surface = React.createElement(MiniAppOverlay, props);

			return React.createElement(React.Fragment, null,
				surface,
				state.toast === null ? null : React.createElement("div", {
					role: "status",
					style: {
						position: "fixed", left: "50%", bottom: 28, transform: "translateX(-50%)",
						zIndex: TOAST_Z_INDEX, maxWidth: "min(560px, 88vw)",
						boxSizing: "border-box", padding: "8px 16px", borderRadius: 999,
						background: T.bgLayer1, border: "1px solid " + T.border2,
						boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
						fontSize: 12, lineHeight: "18px", color: T.text1
					}
				}, state.toast)
			);
		}

		// ------------------------------------------------- 小程序模式与模板面板
		//
		// 空白会话里，「小程序」不只是一个侧栏入口，它同时是 composer 上的一个模式。
		// 它占三个座位 —— hero 上的 chip、输入框旁的 chip、composer 下方的模板面板 ——
		// 三个座位用**同一个 id 与同一个 order** 注册，于是它们永远同进同退。
		//
		// 状态按 sessionId 分片：模式是**会话的属性**，不是全局开关。一个会话铺开了
		// 模板面板，不该让另一个会话的输入框也变样。
		//
		// 交互的关键一步是「选模板 → 变成输入框里的一句话」。入口是 DSH 会话作用域的
		// 标准 prop `inputActions`，见 writeInputDraft 的说明。

		/**
		 * 模式那几面挂的座位名 —— 与 DSH 0.1.5 的 contract **逐字一致**，
		 * 而且每个名字都由 test/seat-contract.test.mjs 对着已安装 asar 的真实声明核过。
		 *
		 * 为什么不是 `conversation.hero.modeActions` / `conversation.input.accessory`：
		 * 这两个名字在 0.1.5 里**不存在**（全 asar 0 匹配）。`ctx.slots.inject` 对未声明的
		 * 名字**静默等待** —— 回调不跑、不报错、也没有任何日志，于是"注册失败"看起来
		 * 和"还没轮到"一模一样。这是同一类事故的第三次（前两次：`data-dsh-sidebar-*`
		 * 全套标记、以及下面要说的 composer.dock），所以它现在有一条自动检查盯着。
		 *
		 * 为什么不是 `conversation.composer.dock`（面板原来的位置）：它在 0.1.5 里存在
		 * （list + session），但渲染点是 `variant === "composer" && …`，而 variant 由
		 * 会话相位给出（`variant: hero ? "hero" : "composer"`）—— 也就是**只在非空白
		 * 会话渲染**。面板是给空白会话用的橱窗，两边条件互斥。
		 */
		var COMPOSER_SLOTS = {
			left: "conversation.input.left",
			dock: "conversation.input.dock"
		};
		/**
		 * `list` 槽位里每一格都要有**自己独有的 id**。
		 *
		 * 注册文档写得很直白："a fresh id is added beside the shipped entries, while
		 * reusing a shipped id puts you in THAT cell and replaces it." —— 所以这里
		 * 一格一个 id：模式 chip、选中态 chip、模板面板、创建意图各占一格。
		 * 它们不再共用同一个 id（旧写法靠"同进同退"来自证，那在换了座位之后没意义了）。
		 */
		var MODE_CHIP_ID = "dsh-miniapp-mode";
		var SELECTION_CHIP_ID = "dsh-miniapp-selection";
		var PANEL_ID = "dsh-miniapp-panel";
		/**
		 * 排序：这些座位上 DSH 自己的条目占 0 / 10 / 20（PPT 占 20），45 落在它们之后。
		 * 同一座位上我们的两格差 1，保证相对次序稳定（chip 在选中态左边）。
		 */
		var COMPOSER_ORDER = 45;

		/**
		 * 「创建」意图那一格的座位名、格子 id 与排序。
		 *
		 * 与面板同一格座位（`conversation.input.dock`，composer 卡片**上方**的整宽条目），
		 * 但用**自己的 id** 另占一格：面板是"看得见的橱窗"，这一格是"到货签收"
		 * （只消费、不渲染），两者的可见条件完全不同，混在一格会让其中一个被另一个的
		 * 返回值决定去留。
		 */
		var CREATE_DRAFT_SLOT = COMPOSER_SLOTS.dock;
		var CREATE_DRAFT_ID = "dsh-miniapp-create";
		var CREATE_DRAFT_ORDER = 45;
		/** 面板高度的下限、与底部留白（可用高度从 DOM 量出来）。 */
		var PANEL_MIN_HEIGHT = 200;
		var PANEL_BOTTOM_GAP = 12;
		var PANEL_MEASURE_FALLBACK = "min(420px, calc(100dvh - 200px))";
		var PANEL_HEIGHT_VAR = "--dsh-miniapp-panel-height";
		/**
		 * 缩略图的几何。
		 *
		 * iframe 按 480 的逻辑宽度渲染，再由 `transform: scale()` 缩到卡片里 ——
		 * 所以缩放系数不是常数，而是跟着瀑布流列宽走（面板量出来再传进来）。
		 * 模板本身就是能跑的小程序，所以预览是**真渲染**，不是画出来的占位图。
		 *
		 * `PREVIEW_LOGICAL_HEIGHT` 现在只剩一个用途：**量不到内容高度时的兜底比例**
		 * （480×300 = 16:10）。真实高度由文档自己通过 postMessage 报上来（见
		 * previewHeightFromMessage），因为每个模板的内容高度都不一样 ——
		 * 统一裁成 16:10 正是这张参考图要改掉的东西。
		 *
		 * `CARD_WIDTH` 同样只剩兜底：可视区宽度还没量到的那一帧拿来用，
		 * 免得首帧画出一个塌掉的预览。
		 */
		var CARD_WIDTH = 168;
		var PREVIEW_LOGICAL_WIDTH = 480;
		var PREVIEW_LOGICAL_HEIGHT = 300;
		/**
		 * 显示高度的上下限（缩放后的像素）。
		 *
		 * 取值的依据是正常那一档列宽：面板 712px、三列 14px 间距时列宽约 225px，
		 * 减去卡片内边距与两层描边后预览内容宽约 203px，于是 scale ≈ 0.42。
		 *
		 *  * MIN = 96 —— 对约 230 逻辑像素。比 16:10 兜底（300 逻辑 → 127）还矮一截，
		 *    只有内容真的极短（一行字的小工具）才会碰到；它防的是卡片缩成一条缝。
		 *  * MAX = 320 —— 对约 760 逻辑像素。面板可视高度在 400〜500px 量级，
		 *    一张卡最多占掉大半屏，不会把后面十张全推到屏幕外。
		 *
		 * 这两个数字是**观感参数**，不是几何真理：改它们只影响裁掉多少，
		 * 不影响布局正确性（外层 overflow:hidden，超长内容被裁、短内容不留空）。
		 */
		var PREVIEW_MIN_HEIGHT = 96;
		var PREVIEW_MAX_HEIGHT = 320;
		/**
		 * 预览量高的 postMessage 协议类型。
		 *
		 * 带插件名前缀是因为 `message` 事件是**整页共享**的：DSH 自己、别的插件、
		 * 各种嵌套 iframe 都会往上发消息。没有前缀就没法判断这条消息是不是我们的。
		 */
		var PREVIEW_MESSAGE_TYPE = "dsh-miniapp:preview-height";
		/**
		 * 视口外扩距离：进到这条线以内就开始取详情、挂预览。
		 *
		 * 它同时决定"有几张卡的 iframe 是活的" —— 预览是**看得见就有**，
		 * 所以这个外扩量给得克制一点：滚出视口的那几张会立刻停下来。
		 */
		var PREVIEW_ROOT_MARGIN = "80px";
		/** 客户端认识的模板分类（与宿主 templates.js 的 TEMPLATE_CATEGORIES 对齐）。 */
		var TEMPLATE_CATEGORY_KEYS = ["timer", "note", "calc", "decide", "play"];
		/** 所有会话的初始快照；也是「这个会话还没被碰过」的答案。 */
		var EMPTY_MODE_STATE = {
			active: false,
			selectedTemplateId: null,
			templates: [],
			loading: false,
			error: "",
			notice: "",
			detail: {}
		};

		/** 从任意异常里取一句能给人看的话。 */
		function describeError(error) {
			if (error === null || error === undefined) return "";
			if (typeof error === "string") return error;
			if (typeof error.message === "string" && error.message !== "") return error.message;
			return String(error);
		}

		// ------------------------------------------------- 预览量高（postMessage 协议）
		//
		// 目标：预览框的高度跟着**模板自己的内容高度**走，而不是统一裁成一个比例框。
		//
		// 为什么只能走 postMessage：预览 iframe 的沙箱串里**没有** `allow-same-origin`
		// （那是安全决策，理由见 IFRAME_SANDBOX 旁边那段），文档因此活在不透明源里，
		// 父页面读它的 `contentDocument` 会当场抛 SecurityError。
		// postMessage 是不透明源唯一还能往外说话的通道。
		//
		// 这段脚本**只做量高这一件事**：它不读页面内容、不碰网络、不写任何存储；
		// 而且它只被拼进预览用的 srcDoc —— 真实运行页的 iframe 走 `src=SERVE/...`，
		// 本地的这段脚本一个字节都不会沾上它。
		//
		// 运行页另有一套**同名不同型**的协议（RUNNER_HEIGHT_MESSAGE_TYPE）：浮窗那一版
		// iframe 在 src 上带 `?embed=1`，由**宿主**（lib/index.js 的 runnerMeasureScript）
		// 把一段同样只量高度的脚本注入到它直出的正文里。两边共用的认领规则是
		// `event.source === iframe.contentWindow`，但消息类型必须不同 —— 否则两条通道
		// 会互相认领对方的高度。

		/**
		 * 预览文档里注入的量高脚本（返回一段 `<script>` 文本）。
		 *
		 * 三件事：量高度、postMessage 出去、内容变化时重发。
		 * 量的是 `documentElement.scrollHeight` 与 `body.scrollHeight` 的较大值 ——
		 * 模板可能把高度给 html 也可能给 body，只量一个会漏。
		 *
		 * `ResizeObserver` 优先，没有就退到 `window.resize`：前者能抓住"内容自己长高"
		 * （比如计时器跳到 00:00 后重排），后者只能抓住窗口尺寸变化，是降级不是等价。
		 */
		function previewMeasureScript() {
			return [
				"<script>(function(){",
				"var TYPE=" + JSON.stringify(PREVIEW_MESSAGE_TYPE) + ";",
				"function measure(){",
				"var root=document.documentElement,body=document.body;",
				"var height=Math.max(",
				"root&&root.scrollHeight?root.scrollHeight:0,",
				"body&&body.scrollHeight?body.scrollHeight:0);",
				"if(!(height>0))return;",
				// 目标窗口写 parent，targetOrigin 写 "*"：不透明源的 origin 是字符串 "null"，
				// 写具体 origin 只会让消息永远发不出去。父页面那边用 event.source 认领（见下）。
				"parent.postMessage({type:TYPE,height:height},\"*\");",
				"}",
				"measure();",
				// 字体/图片迟到会改变高度，load 之后再量一次。
				"window.addEventListener(\"load\",measure);",
				"if(typeof ResizeObserver===\"function\"){",
				"try{new ResizeObserver(measure).observe(document.documentElement);}catch(e){measure();}",
				"}else{window.addEventListener(\"resize\",measure);}",
				"})()<\/script>"
			].join("");
		}

		/**
		 * 把量高脚本插进一份预览文档。
		 *
		 * 不用 `document.write`（它会改写宿主页面，测试里也钉着不许出现），
		 * 字符串拼接是唯一稳当的做法：优先插到 `</body>` 之前，其次 `</html>` 之前；
		 * 两者都没有（模板给的是片段或干脆没闭合）就追加到末尾 —— 浏览器解析 srcDoc 时
		 * 会把缺失的 html/body 补出来，末尾的脚本照样会执行。
		 *
		 * 大小写不敏感：模板自己完全可能写 `</BODY>`。
		 */
		function withPreviewMeasure(html, script) {
			if (typeof html !== "string" || html === "") return html;
			var at = html.search(/<\/body\s*>/i);
			if (at < 0) at = html.search(/<\/html\s*>/i);
			if (at < 0) return html + script;
			return html.slice(0, at) + script + html.slice(at);
		}

		/**
		 * 从一条 `message` 事件里取出预览逻辑高度；认不出来就返回 0。
		 *
		 * **必须用 `event.source` 认领，不能用 `event.origin`**：沙箱没有
		 * `allow-same-origin`，预览文档的源是不透明的，它发出来的消息 `origin`
		 * 一律是字符串 `"null"` —— 页面上任何别的 iframe（包括别人的插件）发来的
		 * 诚实消息也长这样，靠 origin 判断等于没判断。
		 *
		 * `event.source` 是发出消息那个窗口对象本身，只有真的从**这一个** iframe
		 * 里发出的消息才会全等 —— 页面上的第三方代码伪造不出另一个窗口的引用。
		 *
		 * 拆成纯函数是为了能直接单测：真实的浏览器里这条逻辑藏在一个
		 * useEffect 里，而单测的 vm 里既没有 postMessage 也没有真的 effect。
		 */
		function previewHeightFromMessage(event, frameWindow) {
			if (event === null || event === undefined || typeof event !== "object") return 0;
			if (frameWindow === null || frameWindow === undefined) return 0;
			if (event.source !== frameWindow) return 0;
			var data = event.data;
			if (data === null || typeof data !== "object") return 0;
			if (data.type !== PREVIEW_MESSAGE_TYPE) return 0;
			var height = data.height;
			// 只认有限的、正的**数字**：NaN / Infinity / 负数 / 数字字符串一律丢掉，
			// 否则 `height: "1e999"` 之类会把卡片撑成一堵墙。
			if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return 0;
			return Math.ceil(height);
		}

		/**
		 * 逻辑高度 → 显示高度。
		 *
		 * `scale` 是 iframe 的缩放系数（预览内容宽 / 480），显示高度必须跟着它换算，
		 * 否则列宽一变预览就会被拉伸或压扁。最后夹到 [MIN, MAX]：
		 * 超长页面裁掉，极短页面不至于缩成一条缝。量不到时调用方传进来的就是
		 * `PREVIEW_LOGICAL_HEIGHT`，于是这里自然退化成改造前那个 16:10 的比例。
		 */
		function previewDisplayHeight(logicalHeight, scale) {
			if (!Number.isFinite(logicalHeight) || logicalHeight <= 0) logicalHeight = PREVIEW_LOGICAL_HEIGHT;
			if (!Number.isFinite(scale) || scale <= 0) scale = 1;
			var value = Math.round(logicalHeight * scale);
			if (!Number.isFinite(value)) value = PREVIEW_MIN_HEIGHT;
			return Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_MIN_HEIGHT, value));
		}

		/**
		 * 把一句话放进输入框。
		 *
		 * 入口是 DSH 在**会话作用域**里发布的标准 prop `inputActions`：它是
		 * ui-conversation 的 `SessionInputShell.actions`，注释原文是
		 * "The public provide-channel action face (one stable identity per session)"，
		 * 上面只挂 setDraft / addImages / removeImage / pruneImages / submit。
		 * `setDraft(text)` 的契约是"程序化写入整份草稿"：写完光标落在末尾、文字保持
		 * 可编辑、并且和用户自己敲进去的草稿共用同一条历史（不会变成单独一步撤销）。
		 *
		 * 返回 false 只有一种可能：更老的 DSH 上没有这个 prop 或形状不同。这时不假装
		 * 成功 —— 交给调用方降级，并把失败说出来。
		 */
		function writeInputDraft(inputActions, text) {
			if (inputActions === undefined || inputActions === null) return false;
			if (typeof inputActions.setDraft !== "function") return false;
			if (typeof text !== "string" || text === "") return false;
			try {
				inputActions.setDraft(text);
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 按当前界面语言取模板的文案面。
		 *
		 * 接口返回的是 `{ zh: { name, prompt }, en: { name, prompt } }`，两种语言都在
		 * 手里，选哪一面是客户端的事。缺哪一面就依次回落，最后一定回落到 en / zh，
		 * 绝不把 `undefined` 画到界面上。
		 */
		function templateFace(template, localeId) {
			if (template === null || typeof template !== "object") return { name: "", prompt: "" };
			var keys = [];
			if (typeof localeId === "string" && localeId !== "") {
				keys.push(localeId);
				keys.push(localeId.split("-")[0]);
			}
			keys.push("en");
			keys.push("zh");
			for (var index = 0; index < keys.length; index += 1) {
				var face = template[keys[index]];
				if (face !== null && typeof face === "object") {
					var name = typeof face.name === "string" ? face.name : "";
					var prompt = typeof face.prompt === "string" ? face.prompt : "";
					if (name !== "" || prompt !== "") return { name: name, prompt: prompt };
				}
			}
			return { name: "", prompt: "" };
		}

		/** 分类标签：认识的走文案表，不认识的回显原名 —— 而不是显示裸 key。 */
		function templateCategoryLabel(t, category) {
			if (category === "all") return t("templates.category.all");
			if (TEMPLATE_CATEGORY_KEYS.indexOf(category) >= 0) return t("templates.category." + category);
			return typeof category === "string" && category !== "" ? category : t("templates.category.unknown");
		}

		/** 拉模板列表（不含 html）与单条详情（含 html）。 */
		async function loadTemplateList() {
			var data = await callApi("/templates");
			return Array.isArray(data) ? data : [];
		}
		async function loadTemplateDetail(templateId) {
			return await callApi("/templates/" + encodeURIComponent(templateId));
		}

		/**
		 * 用一份正文直接建一个小程序。
		 *
		 * `create` 带 `html` 就是"建好即发布"（`lib/store.js` 里写着：工作副本与快照是同一份
		 * 文档），所以这里不需要再调一次 publish —— 这个动作由用户点出来，不是 Agent 的改动，
		 * 「改完不会自动生效」那条规则管的是后者。
		 */
		async function createAppFromHtml(input) {
			return await callApi("/apps", {
				method: "POST",
				body: { name: input.name, icon: input.icon, html: input.html }
			});
		}

		/**
		 * 按 sessionId 分片的模式状态。
		 *
		 * 与 OfficePptHeroStore 同构：`Map<sessionId, state>` + `Map<sessionId, listeners>`，
		 * 快照是不可变对象，于是 useSyncExternalStore 的比较是可靠的。
		 */
		function MiniAppModeStore() {
			this.states = new Map();
			this.listeners = new Map();
			this.queues = new Map();
			this.inflight = new Map();
			this.listInflight = new Set();
		}

		MiniAppModeStore.prototype.snapshot = function (sessionId) {
			var state = this.states.get(sessionId);
			return state === undefined ? EMPTY_MODE_STATE : state;
		};

		MiniAppModeStore.prototype.subscribe = function (sessionId, listener) {
			var listeners = this.listeners.get(sessionId);
			if (listeners === undefined) {
				listeners = new Set();
				this.listeners.set(sessionId, listeners);
			}
			listeners.add(listener);
			var self = this;
			return function () {
				listeners.delete(listener);
				if (listeners.size === 0) self.listeners.delete(sessionId);
			};
		};

		MiniAppModeStore.prototype.update = function (sessionId, transform) {
			this.states.set(sessionId, transform(this.snapshot(sessionId)));
			var listeners = this.listeners.get(sessionId);
			if (listeners !== undefined) {
				listeners.forEach(function (listener) { listener(); });
			}
		};

		/** 进入 / 离开模式。离开时把选中态一起清掉：下次进来是一个干净的开始。 */
		MiniAppModeStore.prototype.setActive = function (sessionId, active) {
			var next = active === true;
			this.update(sessionId, function (current) {
				return Object.assign({}, current, {
					active: next,
					selectedTemplateId: next ? current.selectedTemplateId : null,
					notice: "",
					error: ""
				});
			});
		};

		MiniAppModeStore.prototype.setLoading = function (sessionId, loading) {
			var next = loading === true;
			this.update(sessionId, function (current) {
				return Object.assign({}, current, {
					loading: next,
					error: next ? "" : current.error
				});
			});
		};

		MiniAppModeStore.prototype.setError = function (sessionId, error) {
			this.update(sessionId, function (current) {
				return Object.assign({}, current, { loading: false, error: error });
			});
		};

		MiniAppModeStore.prototype.setNotice = function (sessionId, notice) {
			this.update(sessionId, function (current) {
				return Object.assign({}, current, { notice: notice });
			});
		};

		MiniAppModeStore.prototype.setTemplates = function (sessionId, templates) {
			var list = Array.isArray(templates) ? templates : [];
			this.update(sessionId, function (current) {
				// 选中态只在它仍然存在时保留 —— 模板被下架时不该留下一个悬空的 id。
				var alive = list.some(function (template) {
					return template !== null && typeof template === "object" && template.id === current.selectedTemplateId;
				});
				return Object.assign({}, current, {
					loading: false,
					templates: list,
					selectedTemplateId: alive ? current.selectedTemplateId : null,
					error: ""
				});
			});
		};

		MiniAppModeStore.prototype.select = function (sessionId, template) {
			var templateId = template !== null && typeof template === "object" ? template.id : null;
			this.update(sessionId, function (current) {
				return Object.assign({}, current, {
					selectedTemplateId: typeof templateId === "string" ? templateId : null,
					loading: false,
					notice: "",
					error: ""
				});
			});
			if (typeof templateId === "string" && templateId !== "") {
				// 选中即预取详情：面板上那张卡马上要显示真预览。
				this.requestDetail(sessionId, templateId, true);
			}
		};

		MiniAppModeStore.prototype.deselect = function (sessionId) {
			this.update(sessionId, function (current) {
				return Object.assign({}, current, { selectedTemplateId: null, notice: "" });
			});
		};

		/** 面板展开时拉一次列表；已经在飞就不再重复发。 */
		MiniAppModeStore.prototype.loadTemplates = function (sessionId) {
			var self = this;
			if (this.listInflight.has(sessionId)) return;
			this.listInflight.add(sessionId);
			this.setLoading(sessionId, true);
			loadTemplateList().then(function (list) {
				self.listInflight.delete(sessionId);
				self.setTemplates(sessionId, list);
			}, function (error) {
				self.listInflight.delete(sessionId);
				self.setError(sessionId, describeError(error));
			});
		};

		MiniAppModeStore.prototype.patchDetail = function (sessionId, templateId, patch) {
			this.update(sessionId, function (current) {
				var detail = Object.assign({}, current.detail);
				detail[templateId] = Object.assign(
					{ status: "loading", html: "", error: "" },
					detail[templateId],
					patch
				);
				return Object.assign({}, current, { detail: detail });
			});
		};

		/**
		 * 按需拉一条模板的详情。
		 *
		 * 列表接口**不含 html**，而预览要真渲染，所以详情只能按需取。策略是三条：
		 *   1. 只有接近视口的卡片才会排队（组件侧用 IntersectionObserver 把关）；
		 *   2. 队列是**串行**的 —— 面板永远不会同时打 12 个请求；
		 *   3. 悬停 / 选中会把这张卡提到队首（urgent），因为用户马上要看它。
		 */
		MiniAppModeStore.prototype.requestDetail = function (sessionId, templateId, urgent) {
			if (typeof templateId !== "string" || templateId === "") return;
			var current = this.snapshot(sessionId);
			var entry = current.detail[templateId];
			if (entry !== undefined && entry.status === "ready") return;
			if (this.inflight.get(sessionId) === templateId) return;
			var queue = this.queues.get(sessionId);
			if (queue === undefined) {
				queue = [];
				this.queues.set(sessionId, queue);
			}
			var at = queue.indexOf(templateId);
			var first = urgent === true;
			if (at >= 0) {
				if (!first || at === 0) return;
				queue.splice(at, 1);
			}
			if (first) queue.unshift(templateId);
			else queue.push(templateId);
			if (entry === undefined || entry.status === "error") {
				this.patchDetail(sessionId, templateId, { status: "loading", html: "", error: "" });
			}
			this.drainDetail(sessionId);
		};

		MiniAppModeStore.prototype.drainDetail = function (sessionId) {
			if (this.inflight.has(sessionId)) return;
			var queue = this.queues.get(sessionId);
			if (queue === undefined || queue.length === 0) return;
			var templateId = queue.shift();
			var self = this;
			this.inflight.set(sessionId, templateId);
			loadTemplateDetail(templateId).then(function (template) {
				var html = template !== null && typeof template === "object" && typeof template.html === "string"
					? template.html
					: "";
				self.patchDetail(sessionId, templateId, { status: html === "" ? "error" : "ready", html: html, error: "" });
			}, function (error) {
				self.patchDetail(sessionId, templateId, { status: "error", html: "", error: describeError(error) });
			}).then(function () {
				self.inflight.delete(sessionId);
				self.drainDetail(sessionId);
			});
		};

		/** 订阅一个会话的模式快照。缺 store 时给一份恒定的空状态，而不是炸掉整个座位。 */
		function useMode(mode, sessionId) {
			var missing = mode === undefined || mode === null;
			var subscribe = useCallback(function (listener) {
				return missing ? function () { } : mode.subscribe(sessionId, listener);
			}, [mode, sessionId, missing]);
			var read = useCallback(function () {
				return missing ? EMPTY_MODE_STATE : mode.snapshot(sessionId);
			}, [mode, sessionId, missing]);
			return React.useSyncExternalStore(subscribe, read, read);
		}

		// ------------------------------------------------------ 模式 chip

		/**
		 * 模式 chip 的**布局**。
		 *
		 * 只有这一部分归我们：DSH 的 hero 模式行规则不管 display / align-items。
		 * 高度、内边距、边框、圆角、底色、字色全在它手里（见 MiniAppModeChip）。
		 */
		var CHIP_LAYOUT_STYLE = { display: "inline-flex", alignItems: "center" };

		/**
		 * 选择 chip（输入框旁那一格）的公共外形。
		 *
		 * 它**不在** hero 的模式行里，没有那条 `!important` 规则，所以这里的每一项都真的生效。
		 * 刻意不含 `color` / `background`：那两条由每种状态各自决定。
		 *
		 * 边框写**长写**而不是 `border: "1px solid " + var(...)`：带 var() 的简写在 CSSOM 里
		 * 是延迟替换值，之后再设 `borderColor` 会把整条简写打回初始值 —— 边框会整个消失。
		 */
		var CHIP_STYLE = {
			display: "inline-flex", flex: "0 0 auto", alignItems: "center", gap: 6,
			height: 30, padding: "0 12px", borderRadius: 999,
			borderStyle: "solid", borderWidth: 1, borderColor: T.border1,
			font: "inherit", fontSize: 12, lineHeight: "16px",
			cursor: "pointer", whiteSpace: "nowrap",
			transition: "color 120ms, background 120ms, border-color 120ms"
		};

		/**
		 * 模式 chip。
		 *
		 * 名字**永远是「小程序」** —— 选中不加"模式"两个字，也不加关闭叉：它是一枚状态标记，
		 * 再点一下就是退出，这件事由 `title` / `aria-label` 说明。
		 *
		 * **它长什么样是 DSH 决定的，不是我们。** hero 的模式行有一条规则：
		 *
		 *   .…_heroModeCluster button{ height:28px; padding:0 8px!important; border:0!important;
		 *     border-radius:8px!important; background:transparent!important;
		 *     color:var(--dsw-alias-label-primary)!important; font-size:13px; font-weight:500; … }
		 *
		 * 选中态再叠一条全局规则：
		 *
		 *   button[data-selected=true]{ background: color-mix(…state-business-primary 10%…)!important;
		 *                               color: var(--dsw-alias-state-business-primary)!important }
		 *
		 * 两条都带 `!important`，所以内联的边框、圆角、底色、字色**一律不会出现**
		 * （实测过：写上去也是 0px none）。`dsh-ppt` 的模式 chip 就在同一个座位上，
		 * 它那套 border / padding / border-radius 同样不生效 —— 也就是说，
		 * 「照 PPT 的选中效果」落到这里就是一件事：**挂上 `data-selected`，
		 * 让这两条规则把样子画出来**。我们只保留 DSH 没管的部分：flex 与垂直居中。
		 */
		function MiniAppModeChip(props) {
			var t = props.t;
			var active = props.active === true;
			return React.createElement("button", {
				type: "button",
				"data-selected": active ? "true" : undefined,
				"aria-pressed": active,
				"aria-expanded": active,
				// 名字不变，所以"再点一下会退出"这件事只能由 title / aria-label 说明。
				title: active ? t("mode.exit") : t("mode.chip"),
				onClick: props.onToggle,
				style: CHIP_LAYOUT_STYLE
			},
				React.createElement(Icon, { name: "app", size: 14 }),
				React.createElement("span", null, t("mode.chip"))
			);
		}

		function MiniAppInputAccessory(props) {
			var state = useMode(props.mode, props.sessionId);
			// 输入框旁这一格显示的是「你选了什么」，不是第二个模式开关 ——
			// 模式开关在 hero 那一行（和「创造模式」并排），这里重复一遍只是噪音。
			// 这与 dsh-ppt 的分工一致：它的 accessory 渲染选中的模板块，而不是模式 chip。
			if (!state.active) return null;
			var localeId = typeof props.localeOf === "function" ? props.localeOf() : "";
			var selected = selectedFace(state, localeId);
			if (selected === null) return null;
			return React.createElement(MiniAppSelectionChip, {
				t: props.t,
				face: selected,
				onRemove: function () { props.mode.deselect(props.sessionId); }
			});
		}

		/**
		 * 在已经取到的模板列表里按 id 找当前选中的那一条。
		 *
		 * 刻意**不**为此再取一次详情：`state.templates` 就是列表投影，名字与图标都在里面，
		 * 而这一格只需要名字。取不到（列表还没回来、或 id 不在列表里）就返回 null ——
		 * 那时候画一个空壳比不画更糟。
		 */
		function selectedFace(state, localeId) {
			var id = state.selectedTemplateId;
			if (typeof id !== "string" || id === "") return null;
			var templates = state.templates;
			for (var index = 0; index < templates.length; index += 1) {
				var template = templates[index];
				if (template === null || typeof template !== "object") continue;
				if (template.id !== id) continue;
				var face = templateFace(template, localeId);
				// `icon` 是模板自己的字段，不参与语言回落 —— 它是 emoji，没有语言。
				return { id: id, name: face.name, icon: typeof template.icon === "string" ? template.icon : "" };
			}
			return null;
		}

		/** 选中态：`🍅 番茄钟 ✕`，按一下就取消选择（输入框里已经写好的字不动）。 */
		function MiniAppSelectionChip(props) {
			var t = props.t;
			var face = props.face;
			var [hover, setHover] = useState(false);
			var label = face.name !== "" ? face.name : face.id;
			return React.createElement("button", {
				type: "button",
				"data-dsh-miniapp-selection": face.id,
				title: t("mode.removeTemplate") + ": " + label,
				"aria-label": t("mode.selectedTemplate") + ": " + label,
				onClick: props.onRemove,
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: Object.assign({}, CHIP_STYLE, {
					color: hover ? T.text1 : T.text2,
					borderColor: hover ? T.border2 : T.border1,
					background: hover ? T.fill : "transparent"
				})
			},
				face.icon !== ""
					? React.createElement("span", { "aria-hidden": "true" }, face.icon)
					: React.createElement(Icon, { name: "app", size: 14 }),
				React.createElement("span", {
					style: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }
				}, label),
				React.createElement(Icon, { name: "close", size: 11 })
			);
		}

		// ------------------------------------------------------ 模板面板
		//
		// 版式对齐 dsh-ppt 的模板面板（用户要的就是那套布局），三条要点：
		//
		//  1. **面板自己不画底**。透明、无边框、无阴影 —— 视觉重量全部落在卡片上。
		//     原来那块带边框和阴影的白底，读起来像"另一个浮层"，而不是输入框的延伸。
		//  2. **宽度与输入框逐像素对齐**。DSH 把 composer 的宽度放在两个变量里：
		//     `--dsh-composer-card-max-width`（卡片上限）与 `--dsh-composer-side-clearance`
		//     （两侧留白 16px）。根节点吃下那 16px 的 padding，面板再按 100% 铺开，
		//     于是它的左右边缘正好落在输入框卡片的边缘上（实测：卡片 712px ↔ 面板 712px）。
		//  3. 卡片走 **三列瀑布流**（CSS 多列，见 PANEL_GRID_STYLE），不是固定 168px 居中 ——
		//     固定宽度在窄窗口里会在两侧留出参差的空隙；行对齐的栅格则做不出
		//     "卡片高度跟着内容走"的参考图效果。

		/** 面板两侧的留白：用 DSH 自己的变量，取不到时退到它当前的默认值 16px。 */
		var COMPOSER_CLEARANCE = "var(--dsh-composer-side-clearance, 16px)";
		/** composer 卡片宽度上限，同样用 DSH 的变量。 */
		var COMPOSER_CARD_MAX = "var(--dsh-composer-card-max-width, 744px)";

		var PANEL_ROOT_STYLE = {
			position: "relative", boxSizing: "border-box",
			width: "100%", height: 0, overflow: "visible",
			// 让出卡片两侧的留白，于是面板的内容盒宽度就是卡片的宽度。
			padding: "0 " + COMPOSER_CLEARANCE
		};
		var PANEL_STYLE = {
			position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
			boxSizing: "border-box", width: "100%",
			// 和 PPT 一样多要 2 × clearance：面板在吃到 padding 的内容盒里，这样才刚好等于卡片宽。
			maxWidth: "calc(" + COMPOSER_CARD_MAX + " + 2 * " + COMPOSER_CLEARANCE + ")",
			marginTop: 8, zIndex: 2,
			height: "var(" + PANEL_HEIGHT_VAR + ", " + PANEL_MEASURE_FALLBACK + ")",
			maxHeight: "var(" + PANEL_HEIGHT_VAR + ", " + PANEL_MEASURE_FALLBACK + ")",
			display: "flex", flexDirection: "column", overflow: "hidden",
			padding: 0, border: 0, borderRadius: 0, boxShadow: "none", background: "transparent"
		};
		var PANEL_TOOLBAR_STYLE = {
			display: "flex", flex: "0 0 auto", alignItems: "center", position: "relative",
			justifyContent: "space-between", gap: 12, minHeight: 38, minWidth: 0,
			background: "transparent"
		};
		/**
		 * 分类条：一条朴素的横向文字 tab，放不下时可以横滚。
		 *
		 * `scrollbarWidth: "none"` 是参考图那一条的关键 —— 分类条上出现一根滚动条
		 * 会让它读起来像"一个容器"，而它不是，它只是一行字。
		 */
		var PANEL_TABS_STYLE = {
			display: "flex", flex: "0 0 auto", alignItems: "center", gap: TAB_GAP,
			minWidth: 0, overflowX: "auto", overflowY: "hidden",
			scrollbarWidth: "none", msOverflowStyle: "none"
		};
		var PANEL_HINT_STYLE = {
			flex: "1 1 auto", minWidth: 0, textAlign: "right", fontSize: 11, lineHeight: "16px",
			color: T.text2, opacity: 0.72,
			overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
		};
		var PANEL_VIEWPORT_STYLE = {
			flex: "1 1 auto", minHeight: 0,
			overscrollBehavior: "contain", overflowY: "auto", overflowX: "hidden",
			paddingBottom: 12
		};
		var PANEL_STATE_STYLE = {
			display: "grid", placeItems: "center", alignContent: "center", gap: 10,
			minHeight: 150, padding: "24px 12px", textAlign: "center",
			fontSize: 12, lineHeight: "18px", color: T.text2
		};
		var PANEL_BANNER_STYLE = {
			marginBottom: 8, padding: "7px 10px", borderRadius: 8, fontSize: 11, lineHeight: "16px",
			border: "1px solid " + tint(T.danger, 40), background: tint(T.danger, 10), color: T.danger
		};
		/**
		 * 「已创建…」这类**成功**回执。
		 *
		 * 它和错误横幅共用一块地方，但绝不能共用一套颜色 —— 一句"已经建好了"画成红色，
		 * 用户会先去找哪里出错了。
		 */
		var PANEL_NOTICE_STYLE = {
			marginBottom: 8, padding: "7px 10px", borderRadius: 8, fontSize: 11, lineHeight: "16px",
			border: "1px solid " + tint(T.success, 40), background: tint(T.success, 10), color: T.success
		};
		/**
		 * 瀑布流的列数 —— 对齐参考图那个模板广场的节奏（它也是四列）。
		 *
		 * 注意面板只有输入框那么宽（约 712px），所以四列意味着每张卡约 167px：
		 * 比参考图里那种大卡片小得多，预览里的字会很小、只有轮廓可辨。
		 * 这是"四列"这个选择的直接代价，不是 bug —— 想要看得清卡片内容，
		 * 得把模板广场挪进全屏浮层（那里才有四列大卡片的空间）。
		 */
		var PANEL_COLUMNS = 4;
		/** 列间距，同时也是卡片之间的纵向间距（卡片吃 marginBottom，见 PANEL_CARD_STYLE）。 */
		var PANEL_GRID_GAP = 14;
		/**
		 * 瀑布流容器 —— 真·多列，不是行对齐的栅格。
		 *
		 * 为什么是 CSS 多列而不是别的：
		 *  * `grid-template-rows: masonry` 至今只有 Firefox 认，Chromium 里会静默退化成
		 *    普通行对齐栅格，等于没改；
		 *  * JS 分列（各自量高再搬 DOM）要在"详情刚到、iframe 刚挂上"时反复重排，
		 *    正是这个面板最容易抖的时刻；
		 *  * 多列是纯 CSS：卡片按 `break-inside: avoid` 自己找位置，高度不一也各归各的，
		 *    行与行之间不需要对齐，而且**不需要额外测量任何东西**。
		 *
		 * 多列唯一要留意的语义是"列优先"（先填满第一列再填第二列），对模板广场这种
		 * 一眼扫过去的列表没有影响。
		 *
		 * 列宽公式**一个字都没改**（见组件里 `Math.floor((gridWidth - gap*(n-1))/n)`）：
		 * 预览 iframe 是按 480 逻辑宽渲染再缩放的，缩放系数必须等于真实列宽，
		 * 公式一改预览就会缩放错。多列里的列宽同样是这个值 ——
		 * `column-gap` 吃掉的正是 `gap × (列数-1)`，剩下的被 `column-count` 三等分。
		 */
		var PANEL_GRID_STYLE = {
			columns: PANEL_COLUMNS,
			columnGap: PANEL_GRID_GAP + "px",
			// 显式写出来（也是默认值）：容器高度是 auto，所以 balance 会把内容摊平到三列，
			// 想要的那种"各列长短不一"就是它的正常结果。
			columnFill: "balance"
		};
		/**
		 * 分类 tab：参考图里那种**朴素横向文字条**。
		 *
		 * 选中态只有"深色 + 加粗"，没有胶囊底色、没有边框 —— 参考图上未选中的 tab
		 * 就是一片浅灰的文字。底色留给卡片（卡片有面之后，tab 再带底色就抢戏了）。
		 */
		/**
		 * 分类筛选 tab —— 逐项照抄 `dsh-ppt` 的 `.…_categoryTabs`：
		 *
		 *   .…_categoryTabs button { color:var(--dsw-alias-label-caption); background:0 0;
		 *     border:0; border-radius:999px; padding:5px 10px; font-size:11px; line-height:16px }
		 *   .…_categoryTabs button:hover { color:var(--dsw-alias-label-primary) }
		 *   .…_categoryTabs button[data-selected=true] {
		 *     background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary) }
		 *
		 * 两个不显然的地方：
		 *  * 选中态是一层**半透明的灰底**，不是彩色、也不加粗 —— 它标记"当前筛选"，
		 *    不是强调；彩色留给真正的动作（模式 chip）。
		 *  * 悬停**只提亮文字**，不铺底：铺底会和选中态撞成同一个样子。
		 */
		var TAB_STYLE = {
			flex: "0 0 auto", border: 0, borderRadius: 999, padding: "5px 10px",
			background: "transparent", color: T.caption,
			font: "inherit", fontSize: 11, lineHeight: "16px", cursor: "pointer",
			whiteSpace: "nowrap", fontWeight: 400
		};
		/** tab 之间的水平间距。 */
		var TAB_GAP = 14;
		/** 卡片内边距。预览的宽度换算要减掉它，所以写成常量而不是散落的字面量。 */
		var PANEL_CARD_PADDING = 8;
		/** 卡片描边宽度，同样参与预览宽度的换算。 */
		var PANEL_CARD_BORDER = 1;
		/** 预览框自身的恒定描边宽度，同样参与换算。 */
		var PANEL_PREVIEW_BORDER = 2;
		/**
		 * 一张卡片 = 一块**有面的瓦片**。
		 *
		 * 参考图里每张卡自己带着一圈浅色底 + 圆角 + 极淡描边，预览与文字都在里面。
		 * 这跟"透明卡片 + 只有预览框一圈细线"是两种做法，在瀑布流里差别很大：
		 * 卡片高度参差不齐时，没有面的卡片会糊成一片，看不出哪里是一张卡。
		 *
		 * 面板本体**仍然是透明的**（那条不许变）—— 视觉重量落在卡片上。
		 *
		 * `break-inside: avoid` 必须加在卡片上：不然多列会把一张卡从中间切开
		 * （上面留半张预览、下面留半句话）。`display: block` 是它生效的前提
		 * （分片规则只作用于块级/多列容器这类盒子）。
		 */
		var PANEL_CARD_STYLE = {
			position: "relative", display: "block", boxSizing: "border-box",
			width: "100%", minWidth: 0,
			padding: PANEL_CARD_PADDING,
			marginBottom: PANEL_GRID_GAP,
			borderRadius: 12,
			border: PANEL_CARD_BORDER + "px solid " + T.border1,
			background: T.bgLayer1,
			breakInside: "avoid",
			font: "inherit", color: T.text1, cursor: "pointer",
			textAlign: "left", appearance: "none",
			transition: "border-color 120ms, transform 120ms"
		};
		/**
		 * 预览框。
		 *
		 * 边框**永远是 2px 且透明**（PPT 的做法）：选中只改颜色不改粗细，
		 * 于是点一下卡片不会把周围的内容挤动一格。
		 *
		 * 未选中时不再画那一圈 inset 细线了 —— 卡片自己有描边，两层线会打架。
		 * 底色仍留着：深浅主题下它都和卡片的 bgLayer1 拉得开（深色下更暗、浅色下更亮），
		 * 读起来像"嵌进卡片里的一块屏"。
		 */
		var PANEL_PREVIEW_STYLE = {
			position: "relative", boxSizing: "border-box",
			width: "100%", borderRadius: 9, overflow: "hidden",
			border: "2px solid transparent", background: T.bgBase,
			display: "grid", placeItems: "center",
			transition: "border-color 120ms, box-shadow 120ms, transform 120ms"
		};
		var PANEL_PREVIEW_EMPTY_STYLE = {
			display: "grid", placeItems: "center", gap: 4, padding: "0 10px",
			fontSize: 10, lineHeight: "14px", color: T.text2, opacity: 0.72
		};

		/** 缩略图还没到位时，占位块上那行小字。 */
		function previewNote(t, detail) {
			if (detail !== undefined && detail.status === "error") return t("templates.previewFailed");
			return t("templates.previewLoading");
		}

		/**
		 * 一张模板卡：**预览 + 名称 + 一句描述**，整体是一块有面的瓦片。
		 *
		 * 预览是真的：模板的 html 直接进 `<iframe srcDoc sandbox={IFRAME_SANDBOX}>`，
		 * 只是整块缩到列宽。预览框的高度**跟着模板自己的内容高度走** ——
		 * 高度由文档通过 postMessage 报上来（协议见 previewMeasureScript 那段），
		 * 这就是瀑布流里卡片高矮不一的来源。
		 *
		 * iframe 只在卡片进到可视区时才挂载：面板是可滚动的，十二张卡同时活着意味着
		 * 十二个文档在后台各自跑定时器。详情也只在卡片接近视口时才排队。
		 */
		function MiniAppTemplateCard(props) {
			var t = props.t;
			var template = props.template;
			var face = props.face;
			var selected = props.selected === true;
			var viewport = props.viewport;
			var mode = props.mode;
			var sessionId = props.sessionId;
			var templateId = template.id;
			var [hover, setHover] = useState(false);
			// 卡片在不在可视区里 —— 它决定这张卡的预览**现在**要不要真的渲染。
			//
			// 初值按"有没有 IntersectionObserver"来：有观察者就先当作不在视口里，
			// 由它第一帧的回报纠正（浏览器里几乎立刻发生）；没有观察者的环境
			// （比如单测的 vm）就把每张卡都当成看得见。
			var [inView, setInView] = useState(function () {
				return typeof IntersectionObserver !== "function";
			});
			// 文档自报的内容高度（480 逻辑宽下的逻辑像素）。0 = 还没报到，
			// 这时一律走 16:10 的兜底比例，所以首帧和"没有 postMessage 的环境"都不塌。
			var [measuredHeight, setMeasuredHeight] = useState(0);
			var cardRef = useRef(null);
			var frameRef = useRef(null);

			/**
			 * 进视口 → 排队取详情 + 挂预览。
			 *
			 * 预览是**常驻**的，不再靠悬停点亮：卡片长什么样就是它跑起来什么样，
			 * 不用先把指针移上去才知道自己选的是什么。
			 *
			 * 仍然按"在不在可视区"开关 iframe：面板是可滚动的，十二张卡同时活着意味着
			 * 十二个文档在后台各自跑定时器。可视区里的那几张当然全开，
			 * 滚出去的就停掉 —— 这是"看得见即预览"，不是"全都常驻"。
			 */
			useEffect(function () {
				var node = cardRef.current;
				if (node === null || node === undefined) return undefined;
				if (typeof IntersectionObserver !== "function") {
					// 没有 IntersectionObserver 就把每张卡都当成在视口里。
					setInView(true);
					mode.requestDetail(sessionId, templateId, false);
					return undefined;
				}
				var observer = new IntersectionObserver(function (entries) {
					for (var index = 0; index < entries.length; index += 1) {
						var entry = entries[index];
						setInView(entry.isIntersecting === true);
						if (entry.isIntersecting === true) mode.requestDetail(sessionId, templateId, false);
					}
				}, {
					root: viewport !== null && viewport !== undefined ? viewport.current : null,
					rootMargin: PREVIEW_ROOT_MARGIN
				});
				observer.observe(node);
				return function () { observer.disconnect(); };
			}, [mode, sessionId, templateId, viewport]);

			var detail = props.detail;
			var html = detail !== undefined && detail.status === "ready" ? detail.html : "";
			var frame = inView && html !== "";

			/**
			 * 收预览文档自报的高度。
			 *
			 * 认领与校验的逻辑全在 previewHeightFromMessage 里（那里写清了为什么
			 * **必须**用 event.source 而不是 event.origin 认领）。这里只负责把它挂上、
			 * 并在 effect 清理时摘掉 —— 卡片滚出视口或面板关闭时，iframe 会被卸载，
			 * 监听器必须跟着走，否则窗口上会越积越多。
			 *
			 * 依赖里放的是 `frame` 这个布尔值而不是 iframe 节点：预览从"没有"变成
			 * "有"的那一刻要重新挂（那时 contentWindow 才存在）。
			 */
			useEffect(function () {
				if (!frame) return undefined;
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				var onPreviewMessage = function (event) {
					var frameNode = frameRef.current;
					var height = previewHeightFromMessage(
						event,
						frameNode === null || frameNode === undefined ? null : frameNode.contentWindow
					);
					if (height === 0) return;
					setMeasuredHeight(function (current) { return current === height ? current : height; });
				};
				window.addEventListener("message", onPreviewMessage);
				return function () { window.removeEventListener("message", onPreviewMessage); };
			}, [frame]);

			// 悬停只负责两件小事：整块瓦片抬起 1px，以及把这张卡的详情插到队首（用户正在看它）。
			var engage = useCallback(function () {
				setHover(true);
				mode.requestDetail(sessionId, templateId, true);
			}, [mode, sessionId, templateId]);
			var disengage = useCallback(function () {
				setHover(false);
			}, []);

			// 卡片宽度 = 列宽，由面板量出来（公式见 MiniAppTemplatePanel）。
			// 量不到时退到一个能看的常数，所以首帧也不会塌。
			var cardWidth = props.cardWidth > 0 ? props.cardWidth : CARD_WIDTH;
			// 预览内容的宽度：从列宽里逐层减掉**所有**占宽的东西，不能只减内边距 ——
			//   列宽 − 卡片左右内边距 − 卡片左右描边 = 卡片的内容盒宽度
			//   再 − 预览框自己的左右描边（iframe 绝对定位在它的 padding box 里，
			//   0 点是描边内侧）= iframe 缩放后必须正好铺满的宽度。
			// 少减一项，缩放的 iframe 就会溢出预览框，被 overflow:hidden 裁掉最右边几条像素。
			var previewWidth = Math.max(
				1,
				cardWidth - 2 * PANEL_CARD_PADDING - 2 * PANEL_CARD_BORDER - 2 * PANEL_PREVIEW_BORDER
			);
			var scale = previewWidth / PREVIEW_LOGICAL_WIDTH;
			var logicalHeight = measuredHeight > 0 ? measuredHeight : PREVIEW_LOGICAL_HEIGHT;
			var displayHeight = previewDisplayHeight(logicalHeight, scale);
			/**
			 * iframe 自身的高度也要设上限。
			 *
			 * 显示高度最多 `PREVIEW_MAX_HEIGHT`，比它更高的部分**永远看不到**，
			 * 但 iframe 有多高浏览器就得真按那个尺寸排一次版 —— 一张 480×8000 的文档
			 * 乘上视口里的好几张卡，就是几倍白花的排版开销。
			 * 按缩放系数折回逻辑像素，正好是"最多能看见的那一块"。
			 *
			 * 它同时掐掉一种病态反馈：模板若把高度写成"相对视口"
			 * （`height: calc(100% + 10px)` 之类），就会变成
			 * 量到 → 改 iframe 高度 → 又量到更大的值，一路涨上去。
			 * 有上限时它最多涨到这个封顶值就停住，而显示高度本来就是夹住的。
			 */
			var maxLogicalHeight = Math.ceil(PREVIEW_MAX_HEIGHT / scale);
			var frameHeight = Math.min(logicalHeight, maxLogicalHeight);
			// 选中只换颜色 + 抬起 1px（整块瓦片一起抬，不是只有预览框）。
			var hovered = hover && !selected;

			return React.createElement("button", {
				type: "button",
				ref: cardRef,
				"data-selected": selected ? "true" : undefined,
				"aria-pressed": selected,
				"aria-label": t("templates.select") + ": " + face.name,
				onClick: function () { props.onChoose(template); },
				onMouseEnter: engage,
				onMouseLeave: disengage,
				onFocus: engage,
				onBlur: disengage,
				style: Object.assign({}, PANEL_CARD_STYLE, {
					// 选中：换成 brand 色的描边（语义与预览框那一圈一致）。
					// 悬停：描边加深一档，并把整块瓦片抬起 1px —— 克制，不做阴影。
					borderColor: selected ? T.brand : hovered ? T.border2 : T.border1,
					transform: hovered ? "translateY(-1px)" : "none"
				})
			},
				React.createElement("span", {
					style: Object.assign({}, PANEL_PREVIEW_STYLE, {
						// 边框粗细恒定（见 PANEL_PREVIEW_STYLE），选中只换颜色。
						borderColor: selected ? T.brand : "transparent",
						// 高度 = 量到的逻辑高度 × 缩放系数，夹在 [MIN, MAX] 之间。
						// 超长页面被 overflow:hidden 裁掉，短页面不留空（除了触到 MIN 时）。
						height: displayHeight
					})
				},
					frame ? React.createElement("iframe", {
						ref: frameRef,
						// 与运行页共用同一条授权串；模板渲染不出东西时下面那层占位仍在。
						sandbox: IFRAME_SANDBOX,
						// 这里插一段**只用来量高度**的脚本（不读内容、不碰网络、不写存储）。
						// 运行页的 iframe 走 src=SERVE/...，正文一个字节都不会带这段脚本。
						srcDoc: withPreviewMeasure(html, previewMeasureScript()),
						title: face.name,
						tabIndex: -1,
						"aria-hidden": "true",
						style: {
							// 绝对定位而不是参与栅格居中：缩放的锚点是左上角，居中会切错边。
							position: "absolute", top: 0, left: 0,
							display: "block", border: 0, background: "#fff",
							// iframe 自身用**量到的逻辑高度**（量不到就是 16:10 兜底）：
							// 文档按这个高度排版，量出来的 scrollHeight 才是真实的。
							// 超过"显示上限折算回来的逻辑高度"时封顶，理由见上面 frameHeight。
							width: PREVIEW_LOGICAL_WIDTH, height: frameHeight,
							transform: "scale(" + scale + ")",
							transformOrigin: "0 0",
							// 缩略图不该抢走卡片的点击；也免得模板自己在后台抢焦点。
							pointerEvents: "none"
						}
					}) : null,
					frame ? null : React.createElement("span", { style: PANEL_PREVIEW_EMPTY_STYLE },
						React.createElement("span", { "aria-hidden": "true", style: { fontSize: 26, lineHeight: "30px" } },
							typeof template.icon === "string" && template.icon !== "" ? template.icon : "🧩"),
						React.createElement("span", null, previewNote(t, detail))
					)
				),
				React.createElement("span", {
					style: {
						display: "flex", alignItems: "center", gap: 3,
						width: "100%", paddingTop: 6, fontSize: 12, lineHeight: "16px",
						color: selected ? T.text1 : T.text2,
						overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
					}
				},
					selected ? React.createElement(Icon, { name: "check", size: 12 }) : null,
					React.createElement("span", {
						// flex 子项默认不肯缩到内容宽度以下，`minWidth: 0` 才让 ellipsis 生效
						// （否则长名字会直接顶出卡片右边缘）。
						style: {
							flex: "1 1 auto", minWidth: 0,
							overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
						}
					}, face.name)
				),
				// 一句描述，取自模板自带的 prompt（就是点卡片会写进输入框的那句话）。
				// 两行截断：`display:-webkit-box` + `-webkit-line-clamp` 是唯一不靠 JS
				// 测量就能做多行省略的做法；`overflow:hidden` 必须一起给，
				// 否则 clamp 不生效、第三行会漏出来把卡片撑高。
				// 选中态保持 text2 —— 描述是辅助信息，不该和名称抢注意力。
				React.createElement("span", {
					style: {
						display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2,
						overflow: "hidden",
						paddingTop: 4, fontSize: 12, lineHeight: "16px", color: T.text2,
						overflowWrap: "anywhere"
					}
				}, face.prompt)
			);
		}

		/**
		 * 模板面板：分类 tab + 真渲染的模板瀑布流 + 三种空态。
		 *
		 * 高度从 DOM 量出来：面板挂在 composer 下方（零高度的锚点 + 绝对定位），
		 * 可用高度 = 会话滚动区底边 − 面板顶边 − 留白，ResizeObserver 跟着跟。
		 * 面板关着的时候整个组件返回 null —— 不给会话留任何 DOM。
		 */
		function MiniAppTemplatePanel(props) {
			var t = props.t;
			var mode = props.mode;
			var sessionId = props.sessionId;
			var state = useMode(mode, sessionId);
			var rootRef = useRef(null);
			var panelRef = useRef(null);
			var viewportRef = useRef(null);
			var [category, setCategory] = useState("all");
			var [creating, setCreating] = useState(false);
			var [gridWidth, setGridWidth] = useState(0);

			var templates = state.templates;
			var categories = useMemo(function () {
				var seen = ["all"];
				for (var index = 0; index < templates.length; index += 1) {
					var item = templates[index];
					var name = item !== null && typeof item === "object" ? item.category : undefined;
					if (typeof name === "string" && name !== "" && seen.indexOf(name) < 0) seen.push(name);
				}
				return seen;
			}, [templates]);

			// 展开时拉一次列表（列表接口不含 html）。
			useEffect(function () {
				if (!state.active) return;
				if (state.loading || state.templates.length > 0 || state.error !== "") return;
				mode.loadTemplates(sessionId);
			}, [mode, sessionId, state.active, state.loading, state.templates.length, state.error]);

			// 分类被切走（模板换了、分类没了）时回到「全部」。
			useEffect(function () {
				if (categories.indexOf(category) < 0) setCategory("all");
			}, [categories, category]);

			// 量一次可视区宽度，算出瀑布流里每一列有多宽。
			// 卡片的预览是按逻辑尺寸渲染再缩放的，缩放系数必须跟着列宽走，
			// 所以这个数字既决定预览的高度，也决定 iframe 的 scale。
			useEffect(function () {
				if (!state.active) return undefined;
				var viewport = viewportRef.current;
				if (viewport === null || viewport === undefined) return undefined;
				var sync = function () {
					var next = Math.round(viewport.clientWidth);
					if (next > 0) setGridWidth(function (current) { return current === next ? current : next; });
				};
				var observer = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
				if (observer !== null) observer.observe(viewport);
				window.addEventListener("resize", sync);
				var raf = window.requestAnimationFrame(sync);
				return function () {
					window.cancelAnimationFrame(raf);
					if (observer !== null) observer.disconnect();
					window.removeEventListener("resize", sync);
				};
			}, [state.active]);

			// 高度自适应：会话滚动区底边决定面板能铺多高。
			useEffect(function () {
				if (!state.active) return undefined;
				var root = rootRef.current;
				var panel = panelRef.current;
				if (root === null || panel === null) return undefined;
				if (typeof root.closest !== "function") return undefined;
				var scrollBody = root.closest("[data-conversation-scroll]");
				var seat = root.closest("[data-composer-seat]");
				var composerCard = seat === null || seat === undefined ? null : seat.querySelector("[data-composer-card]");
				if (scrollBody === null || composerCard === null) return undefined;
				var sync = function () {
					var scrollRect = scrollBody.getBoundingClientRect();
					var panelRect = panel.getBoundingClientRect();
					var available = Math.max(PANEL_MIN_HEIGHT, Math.floor(scrollRect.bottom - panelRect.top - PANEL_BOTTOM_GAP));
					root.style.setProperty(PANEL_HEIGHT_VAR, available + "px");
				};
				var observer = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
				if (observer !== null) {
					observer.observe(scrollBody);
					observer.observe(composerCard);
				}
				window.addEventListener("resize", sync);
				var frame = window.requestAnimationFrame(sync);
				return function () {
					window.cancelAnimationFrame(frame);
					if (observer !== null) observer.disconnect();
					window.removeEventListener("resize", sync);
					root.style.removeProperty(PANEL_HEIGHT_VAR);
				};
			}, [state.active]);

			if (!state.active) return null;

			// 界面语言在渲染时读一次：DSH 切语言会让整个 outlet 重渲染，所以这里
			// 拿到的永远是当前那一种。
			var localeId = typeof props.localeOf === "function" ? props.localeOf() : "";
			var visible = [];
			for (var index = 0; index < templates.length; index += 1) {
				var template = templates[index];
				if (template === null || typeof template !== "object") continue;
				if (category !== "all" && template.category !== category) continue;
				visible.push({
					template: template,
					id: typeof template.id === "string" ? template.id : "",
					face: templateFace(template, localeId)
				});
			}
			var selected = null;
			for (var scan = 0; scan < visible.length; scan += 1) {
				if (visible[scan].id === state.selectedTemplateId) { selected = visible[scan]; break; }
			}

			/**
			 * 一列有多宽 —— **公式与改造前逐字相同**，不许改。
			 *
			 * 预览 iframe 是按 480 逻辑宽渲染再缩放的，`scale = 预览内容宽 / 480`，
			 * 而"预览内容宽"由列宽一路减出来（见卡片里的 previewWidth）。
			 * 公式一改，缩放系数就错了，预览会整体缩放错位。
			 *
			 * CSS 多列的列宽同样是这个值：`column-gap` 吃掉 `gap × (列数-1)`，
			 * 余下的被 `column-count` 三等分 —— 两边算的是同一件事。
			 *
			 * 可视区还没量到（首帧）时给 0，卡片会退到 CARD_WIDTH 那个常数，
			 * 避免先画一个塌掉的预览。
			 */
			var cardWidth = gridWidth > 0
				? Math.floor((gridWidth - PANEL_GRID_GAP * (PANEL_COLUMNS - 1)) / PANEL_COLUMNS)
				: 0;

			/**
			 * 「直接创建」：不经过模型，拿模板自己的正文建一个小程序。
			 *
			 * 这条路的读者是"我就要这个"的人 —— 把它交给模型只会重造一遍，
			 * 而我们那份正文里刻意留的缺口（番茄钟固定 25/5 之类）也会丢掉。
			 * 建完即发布：`create` 带 `html` 就是"建好即上线"（见 lib/store.js），
			 * 所以这里不需要用户再按一次发布 —— 这个动作是用户自己发起的，不是 Agent 的改动。
			 *
			 * 另一条路（点卡片 = 把那句话填进输入框）不变 —— 想改一改再让 AI 做的人走那条。
			 *
			 * **刻意不是 useCallback**：这段代码在 `if (!state.active) return null;` 之后，
			 * 把 hook 放在条件返回后面会让 React 报 #310（"Rendered fewer hooks than expected"）
			 * —— 那是真机上才发现过一次的错误。这里用普通函数，代价只是一次无关紧要的重建，
			 * 与文件里其它内联 handler 也一致。
			 */
			var createNow = async function () {
				if (selected === null || creating) return;
				setCreating(true);
				try {
					var html = "";
					var detail = state.detail[selected.id];
					if (detail !== undefined && detail.status === "ready" && typeof detail.html === "string") {
						html = detail.html;
					} else {
						// 列表接口不带正文，所以这里按 id 取一次；顺手塞回详情缓存，
						// 免得同一个模板的预览再飞一次。
						var fetched = await loadTemplateDetail(selected.id);
						html = typeof fetched.html === "string" ? fetched.html : "";
						mode.patchDetail(sessionId, selected.id, { status: "ready", html: html });
					}
					var app = await createAppFromHtml({
						name: selected.face.name,
						icon: selected.template.icon,
						html: html
					});
					mode.setNotice(sessionId, t("templates.created", { name: app.name }));
				} catch (createError) {
					mode.setNotice(sessionId, t("templates.createFailed", { message: describeError(createError) }));
				} finally {
					setCreating(false);
				}
			};

			var emptyState = null;
			if (state.loading && templates.length === 0) {
				emptyState = React.createElement("div", { style: PANEL_STATE_STYLE }, t("templates.loading"));
			} else if (state.error !== "" && templates.length === 0) {
				emptyState = React.createElement("div", { style: PANEL_STATE_STYLE, role: "alert" },
					React.createElement("span", null, t("templates.loadFailed", { message: state.error })),
					React.createElement(GhostButton, {
						mini: true, icon: "refresh", label: t("templates.retry"),
						onClick: function () { mode.setError(sessionId, ""); }
					})
				);
			} else if (visible.length === 0) {
				emptyState = React.createElement("div", { style: PANEL_STATE_STYLE }, t("templates.empty"));
			}

			return React.createElement("section", {
				ref: rootRef,
				"data-dsh-miniapp-panel": "",
				"aria-label": t("mode.region"),
				style: PANEL_ROOT_STYLE
			},
				React.createElement("div", { ref: panelRef, style: PANEL_STYLE },
					React.createElement("div", { style: PANEL_TOOLBAR_STYLE },
						React.createElement("div", {
							role: "tablist",
							"aria-label": t("templates.categories"),
							style: PANEL_TABS_STYLE
						}, categories.map(function (item) {
							return React.createElement(MiniAppCategoryTab, {
								key: item,
								selected: item === category,
								label: templateCategoryLabel(t, item),
								onPick: function () { setCategory(item); }
							});
						})),
						React.createElement("div", {
							style: {
								display: "flex", flex: "1 1 auto", alignItems: "center",
								justifyContent: "flex-end", gap: 8, minWidth: 0
							}
						},
							React.createElement("div", { style: PANEL_HINT_STYLE },
								selected !== null
									? t("templates.selectedHint", { name: selected.face.name })
									: t("templates.hint")),
							// 只在选中之后出现：没选就没有"直接创建"的对象。
							selected !== null
								? React.createElement(GhostButton, {
									mini: true,
									icon: "plus",
									action: "create-now",
									label: creating ? t("templates.creating") : t("templates.createNow"),
									title: t("templates.createNowTitle"),
									disabled: creating,
									onClick: createNow
								})
								: null
						)
					),
					React.createElement("div", { ref: viewportRef, style: PANEL_VIEWPORT_STYLE },
						state.error !== "" && templates.length > 0
							? React.createElement("div", { style: PANEL_BANNER_STYLE, role: "alert" },
								t("templates.loadFailed", { message: state.error }))
							: null,
						state.notice !== ""
							? React.createElement("div", { style: PANEL_NOTICE_STYLE, role: "status" }, state.notice)
							: null,
						emptyState !== null ? emptyState : React.createElement("div", { style: PANEL_GRID_STYLE },
							visible.map(function (entry) {
								return React.createElement(MiniAppTemplateCard, {
									key: entry.id,
									t: t,
									mode: mode,
									sessionId: sessionId,
									template: entry.template,
									face: entry.face,
									detail: state.detail[entry.id],
									selected: entry.id !== "" && entry.id === state.selectedTemplateId,
									viewport: viewportRef,
									cardWidth: cardWidth,
									onChoose: function (template) { chooseTemplate(props, template); }
								});
							})
						)
					)
				)
			);
		}

		/**
		 * 分类 tab：一条朴素文字，选中 = 深色 + 加粗。
		 *
		 * 语义（role / aria-selected / data-selected）一个字都没动 —— 有测试钉着。
		 * 变的只是外观：没有胶囊、没有底色、没有边框。选中态只换 `color` 与
		 * `fontWeight`，字号不变，所以点一下不会让这一行文字左右抖动。
		 *
		 * 关于 DSH 那条 `button[data-selected=true]{…!important}`：实测它**不是全局规则**，
		 * 选择器是 `.<构建哈希>_heroModeCluster button[data-selected=true]`
		 * （当前这版 DSH 上是 `._8JRpoa_heroModeCluster`；哈希会随构建变，看类名后缀即可）——
		 * 它只管空白会话 hero 那一行的模式 chip，模式 chip 正是靠它上色的。
		 * 分类 tab 在 composer 的 dock 里，不在那个子树里，所以这里的文字色不会被 DSH 抢走。
		 * 这也是为什么可以放心把胶囊底色去掉：没有 `!important` 会把它加回来。
		 */
		function MiniAppCategoryTab(props) {
			var [hover, setHover] = useState(false);
			var on = props.selected === true;
			return React.createElement("button", {
				type: "button",
				role: "tab",
				"aria-selected": on,
				"data-selected": on ? "true" : undefined,
				onClick: props.onPick,
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: Object.assign({}, TAB_STYLE, on
					? { background: T.hoverSurface, color: T.text1 }
					: hover ? { color: T.text1 } : null)
			}, props.label);
		}

		// 面板那一格**没有包装组件**：`MiniAppTemplatePanel` 直接注册到
		// `conversation.input.dock`。原来那个 `MiniAppStandardComposerDock` 包装只做了一件事
		// —— 在 `session.blank !== true` 时返回 null，而它的座位（`conversation.composer.dock`）
		// 本来就只在**非空白**会话渲染：两条条件互斥，正是这个包装让面板永远画不出来。
		// 去掉包装之后，"要不要画"只剩面板自己那个真条件：`if (!state.active) return null`。
		// （`props.session` 缺失也不再需要判空：`MiniAppTemplatePanel` 不使用它。）

		/**
		 * 「点一个模板」的全部动作：把模板的描述写进输入框，并记下选中态。
		 *
		 * 这是整个设计的核心 —— 用户不是"选中了一个模板"，而是**拿到了一句可以改的话**。
		 * 写入失败（只可能发生在更老的 DSH 上）时降级到剪贴板，并把这件事说出来。
		 */
		function chooseTemplate(props, template) {
			var mode = props.mode;
			var sessionId = props.sessionId;
			var t = props.t;
			if (template === null || typeof template !== "object") return;
			if (template.id === mode.snapshot(sessionId).selectedTemplateId) {
				// 再点一次就是取消选择。输入框里的文字**不动** —— 那已经是用户的草稿了。
				mode.deselect(sessionId);
				return;
			}
			var localeId = typeof props.localeOf === "function" ? props.localeOf() : "";
			var face = templateFace(template, localeId);
			// 先写输入框再记选中态：写不进去时 select 仍然会在卡片上留下选中标记，
			// 用户至少知道"我点的是哪一个"，而 notice 会说清楚为什么输入框没变。
			var filled = writeInputDraft(props.inputActions, face.prompt);
			mode.select(sessionId, template);
			if (!filled) {
				copyToClipboard(face.prompt);
				mode.setNotice(sessionId, t("templates.writeFailed"));
			}
		}

		/** 降级路径：写不进输入框时，至少让那句话能被粘贴进去。 */
		function copyToClipboard(text) {
			try {
				if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					void navigator.clipboard.writeText(text);
				}
			} catch (error) {
				// 剪贴板不可用不该让整个选择动作失败。
			}
		}

		/**
		 * 订阅「创建小程序」那次意图。
		 *
		 * 为什么非要订阅（而不是"渲染时读一次"）：`startSession()` 可能**复用**当前这个
		 * 空白会话 —— 那时既没有新会话、也没有重新挂载，消费者早就挂在那儿了。没有订阅，
		 * "人已经在空白会话里点创建"这条路会静默地什么都不发生。
		 */
		function useStagedCreateIntent(intent) {
			var [staged, setStaged] = useState(intent === undefined || intent === null ? false : intent.isStaged());
			useEffect(function () {
				if (intent === undefined || intent === null) return undefined;
				setStaged(intent.isStaged());
				return intent.subscribe(function (next) { setStaged(next); });
			}, [intent]);
			return staged;
		}

		/**
		 * 「创建」意图的落地座位 —— 一个**只消费、不渲染**的座位。
		 *
		 * 它回答的问题是"哪一格能拿到新会话的 `inputActions`"。本插件原本指望自己在
		 * 那三个 composer 座位上消费，但那三个在已安装的 DSH 里都到不了渲染：
		 *  * `conversation.hero.modeActions` 与 `conversation.input.accessory`
		 *    这两个**槽位名根本不存在**（全量搜 app.asar 0 匹配）。`ctx.slots.inject`
		 *    等的是槽位**声明**：声明不存在时它连回调都不会跑，也不报错
		 *    （ui-renderer 的注入控制器 `inject(key, callback)` 在
		 *    `specDynamic(key) === undefined` 时直接返回）。所以那两个座位从来没注册上过。
		 *  * `conversation.composer.dock` 有声明（`kind: "list"` / `scope: "session"`，
		 *    ui-conversation 的 `slots.ts:170`），但它的渲染点是
		 *    `variant === "composer" && …`，而 `variant` 由会话相位给出：
		 *    `variant: hero ? "hero" : "composer"`（ui-conversation/lib/client.js:14907），
		 *    `hero` 只在**空白会话**为真（同文件 :14869）。也就是说：空白会话里它不渲染，
		 *    有内容的会话里渲染了、而本插件的组件又在 `session.blank !== true` 时返回 null。
		 *    两个条件互斥 —— 那一格在图上是死的。
		 *
		 * `conversation.input.dock` 则是能用的那一格，逐条对上这里需要的东西：
		 *  * `kind: "list"` + `scope: "session"`，`replaceRisk: "none"`
		 *    （用自己独有的 id 加一格就是"增加"，`slots.ts:166`）；
		 *  * 渲染点在 hero **之外**无条件执行（ui-conversation/lib/client.js:14928），
		 *    所以空白会话里它真的画；
		 *  * 它把会话 zone 作为 ownerProp 交给条目：`InputZone { session, input }`
		 *    （同文件 :14870），而标准 props 里带 `sessionId` 与 `inputActions`。
		 *    这三样正好是本链路需要的全部。
		 *
		 * 组件**永远返回 null**：它不是界面，是一次到货签收（DSH 自己的 TodoDock 在
		 * 没有 todo 时也是这个形状）。
		 */
		function MiniAppCreateDraftSeat(props) {
			var intent = props.intent;
			var t = props.t;
			var ui = props.ui;
			var staged = useStagedCreateIntent(intent);

			useEffect(function () {
				if (staged !== true) return undefined;
				// 只在**空白会话**上落地：往一段已经开始的对话里塞一条指令是骚扰，
				// 而且原版也只在"新建会话"这条路上进这个模式（docs/design.zh-CN.md）。
				if (props.session === undefined || props.session === null || props.session.blank !== true) return undefined;
				// 读并清：两个空白会话同时挂着时只有一个拿得到，重复渲染也不会写第二遍。
				if (intent.claim() !== true) return undefined;
				if (writeInputDraft(props.inputActions, CREATE_DRAFT) === true) return undefined;
				// 拿不到 `inputActions`（只可能发生在更老的 DSH 上）：不假装成功 ——
				// 退回原来的「复制创建提示词」。这里必须走 `ui.toast`：浮层已经关了，
				// 浮层内部那条 notice 用户根本看不见。
				copyToClipboard(t("create.prompt"));
				ui.set({ toast: t("create.writeFailed") });
				return undefined;
			}, [intent, props.inputActions, props.session, staged, t, ui]);

			return null;
		}

		/**
		 * 「你选了什么」那一格：挂在 `conversation.input.left`（输入工具行左侧）。
		 *
		 * 它**不判 `session.blank`**：0.1.5 里这个座位在空白会话也渲染（渲染点是
		 * `input === void 0 || sessionId === void 0 ? null : renderSlot(…)`，与
		 * hero/composer 无关），而"要不要画"这件事面板与它自己有更准的条件 ——
		 * `useMode(...).active` 与"是否真的选了模板"。多一条 blank 守卫只会让
		 * 用户在已有对话里也用不了这个模式，那是旧座位（幽灵名）留下的错误前提。
		 */
		function MiniAppSelectionChipSeat(props) {
			// 会话作用域的标准 prop：没有 sessionId 就没有"按会话分片"的主体可分。
			if (props.sessionId === undefined) return null;
			return React.createElement(MiniAppInputAccessory, props);
		}

		/**
		 * 模式 chip：挂在 `conversation.input.left`，与「你选了什么」同一行。
		 *
		 * 它原来是 hero 上的那一枚（座位名 `conversation.hero.modeActions` —— 0.1.5 里
		 * 不存在）。**hero 区在 0.1.5 上没有任何加法位**：`conversation.hero.brand.mark` /
		 * `.workspace` / `.agentPreset` 全是 `single` + `root`，而且都被 DSH 自己占着
		 * （注册进去是"替换别人的格子"，不是"加一格"）。所以这枚 chip 回不到 hero，
		 * 这是**产品形态的改动**，写进了 docs。
		 *
		 * **守卫必须在第一个 hook 之前**：两次渲染之间 sessionId 有→无，hook 调用数就变，
		 * React 报 #310。
		 */
		function MiniAppModeChipSeat(props) {
			if (props.session === undefined || props.session === null || props.sessionId === undefined) return null;
			var state = useMode(props.mode, props.sessionId);
			return React.createElement(MiniAppModeChip, {
				t: props.t,
				active: state.active,
				onToggle: function () { props.mode.setActive(props.sessionId, !state.active); }
			});
		}

		// -------------------------------------------------------------- 侧栏入口
		//
		// 「小程序」要长在设置栏右侧（[设置][小程序]），而不是底部动作行的左侧。
		//
		// DSH 的侧栏结构是：
		//   div.footArea
		//     div.footerActions                      ← slot "sidebar.footer.action" { wide }
		//     div.settingsArea                       ← slot "sidebar.settings" { wide }
		//       div[data-slot="sidebar.settings"]    ← 槽位宿主，Renderer 给它 display:contents
		//         div.triggerRow                     ← 设置栏那一行：flex + gap:8px
		//           button（「设置」，flex:1） + 连接状态点
		//
		// `sidebar.settings` 是 kind:"single"，只有一个占位者（settings-general），
		// 所以**不能**再往那个槽位注册第二行。
		//
		// 挂点因此是"设置栏那一行"本身：宿主里第一个 `button` 就是「设置」触发器，
		// 它的 parentElement 就是那一行。这样做有两个好处 —— 不认 CSS Module 的哈希类名
		// （跨版本不保证），也不依赖宿主里到底套了几层。把我们的按钮 append 成那一行的
		// 最后一个孩子，`flex:1` 的「设置」按钮自然让位，我们就落在最右侧。

		/**
		 * 侧栏图标：**四个方块**（2×2 的应用格），与标题栏那一颗是同一个几何
		 * （逐字等于 `ICON_PATHS.app` 的路径）。
		 *
		 * 用 fill 而不是描边：这一行前后都是 DSH 自己的实心图标（设置齿轮、Cordis 面板），
		 * 1.7 的细描边在 19px 上比邻居轻一档，看起来像"没启用"。
		 */
		var SIDEBAR_ICON_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">'
			+ '<path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z"/>'
			+ '</svg>';

		/**
		 * 侧栏按钮的样式表。
		 *
		 * 座位是设置栏那一行（`div.triggerRow`）的**最后一个孩子**。那一行本来就是
		 * `display:flex; gap:8px`，而「设置」按钮是 `flex:1` —— 它吃掉剩余宽度，我们
		 * 就天然落在最右侧。所以这里**没有绝对定位，也没有给宿主补 padding**：
		 * 位置由 DOM 顺序 + 那一行自己的布局决定，改版时更不容易错位。
		 *
		 * 唯一需要分档的是窄轨（侧栏折叠后的 56px 轨道）：那一行在窄轨下被 CSS 收成
		 * 36px，横着塞不下第二颗按钮，所以换成竖排 —— 允许换行，让按钮独占一行。
		 * 分档标记 `data-dsh-miniapp-row` 由 `syncRowMode` 按**量出来的行宽**写，
		 * 不猜类名（类名是哈希）。
		 */
		var SIDEBAR_CSS = [
			"#dsh-miniapp-sidebar-button { appearance:none; flex:none; width:32px; height:32px; color:var(--dsw-alias-label-secondary,#73777f); background:transparent; border:0; border-radius:9px; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; padding:0; }",
			'[data-dsh-miniapp-row="rail"] { flex-wrap:wrap; justify-content:center; }',
			'[data-dsh-miniapp-row="rail"] #dsh-miniapp-sidebar-button { flex-basis:100%; margin-top:2px; }',
			"#dsh-miniapp-sidebar-button:hover { color:var(--dsw-alias-label-primary,#202124); background:var(--dsw-alias-interactive-bg-hover,rgba(32,33,36,.08)); }",
			"#dsh-miniapp-sidebar-button:focus-visible { outline:2px solid #4d6bfe; outline-offset:1px; }"
		].join("\n");

		/** `<style>` 标签的身份，用来去重；清理时按 data-plugin 认领自己的那一份。 */
		var SIDEBAR_STYLE_ID = "dsh-miniapp/sidebar.css";
		var SIDEBAR_BUTTON_ID = "dsh-miniapp-sidebar-button";
		/** 设置栏槽位的宿主元素 —— 这是 DSH 的公共槽位契约，不是内部类名。 */
		var SIDEBAR_SLOT_HOST_SELECTOR = '[data-slot="sidebar.settings"]';
		/** 写在设置栏那一行上的窄轨标记；宽轨时这个属性会被删掉。 */
		var SIDEBAR_ROW_MARKER = "dshMiniappRow";
		/** 行宽不超过这个值就算窄轨（窄轨 36px，宽轨是整条侧栏）。 */
		var SIDEBAR_RAIL_MAX_PX = 48;
		/** MutationObserver 的合并窗口：React 重建子树的中间态不该让我们反复重建按钮。 */
		var SIDEBAR_SETTLE_MS = 60;

		/**
		 * 把「小程序」按钮挂进设置栏那一行。
		 *
		 * 为什么不是注册一个槽位：`sidebar.settings` 是 kind:"single"
		 * （replaceRisk: shadows-shipped-ui），注册第二行会**替换**掉设置按钮本身。
		 *
		 * 挂点按公共契约找：`[data-slot="sidebar.settings"]` 是槽位宿主（Renderer 给它
		 * 的 style 是 `display:contents`，本身不参与布局），宿主里第一个 `button` 就是
		 * 「设置」触发器，它的 parentElement 就是那一行。
		 *
		 * 侧栏折叠 / 展开、设置面板开合都会让 React 重建那棵子树，按钮会被连带移除，
		 * 所以在 body 上挂一个 debounce 过的 MutationObserver 自愈。窄轨 / 宽轨的分档
		 * 另外靠 ResizeObserver 重算 —— 折叠只改 class，不产生 childList 变动，
		 * MutationObserver 看不见。
		 *
		 * @returns 清理函数：断开观察、摘掉按钮、删掉自己注入的那份样式表。
		 */
		function mountSidebarEntry(ui, t) {
			if (typeof document === "undefined") return function () { };
			// 观察根：正常情况下是 body；插件比 body 更早挂上时退到 documentElement
			// （它在 document 存在的那一刻就有了），这样晚到的侧栏仍然会被看见 ——
			// 否则按钮永远不会出现，而且不会有任何报错。
			var observeRoot = document.body || document.documentElement;
			if (!observeRoot) return function () { };

			var createdStyle = null;
			var styleSelector = "style[data-plugin-css=" + JSON.stringify(SIDEBAR_STYLE_ID) + "]";
			if (document.querySelector(styleSelector) === null && document.head) {
				createdStyle = document.createElement("style");
				createdStyle.dataset.plugin = name;
				createdStyle.dataset.pluginCss = SIDEBAR_STYLE_ID;
				createdStyle.textContent = SIDEBAR_CSS;
				document.head.appendChild(createdStyle);
			}

			var observer = null;
			var resizer = null;
			var resizedRow = null;
			var timer = null;
			var button = null;

			/**
			 * 按行宽给那一行打窄轨标记。量宽度而不是认类名：类名是 CSS Module 的哈希，
			 * 跨版本不保证。量到 0（还没布局，或侧栏整个收起来）就保持不动 ——
			 * 否则一次瞬时 0 宽会把宽轨误判成窄轨。
			 */
			var syncRowMode = function (row) {
				var width = typeof row.getBoundingClientRect === "function"
					? row.getBoundingClientRect().width
					: row.clientWidth;
				if (typeof width !== "number" || !(width > 0)) return;
				if (width <= SIDEBAR_RAIL_MAX_PX) row.dataset[SIDEBAR_ROW_MARKER] = "rail";
				else delete row.dataset[SIDEBAR_ROW_MARKER];
			};

			/** 只跟当前这一行；React 把行换掉之后要重新指过去。 */
			var watchRow = function (row) {
				if (resizer === null || resizedRow === row) return;
				resizer.disconnect();
				resizer.observe(row);
				resizedRow = row;
			};

			/** 摘掉按钮并停止量它所在的那一行（不改 `settingsInjected`）。 */
			var unmountButton = function () {
				if (button !== null && button.parentElement !== null) button.parentElement.removeChild(button);
				button = null;
				if (resizer !== null && resizedRow !== null) {
					resizer.disconnect();
					resizedRow = null;
				}
			};

			var ensure = function () {
				var host = document.querySelector(SIDEBAR_SLOT_HOST_SELECTOR);
				// 宿主里第一个 button 是「设置」触发器；它的父元素就是设置栏那一行。
				var trigger = host === null ? null : host.querySelector("button");
				var row = trigger === null || trigger === undefined ? null : trigger.parentElement;
				if (row === null || row === undefined) {
					// 侧栏整块还没挂上（或正在重建）：把按钮摘掉，等下一次 ensure 再来。
					unmountButton();
					if (ui.get().settingsInjected !== false) ui.set({ settingsInjected: false });
					return;
				}
				if (button === null) {
					button = document.createElement("button");
					button.id = SIDEBAR_BUTTON_ID;
					button.type = "button";
					button.innerHTML = SIDEBAR_ICON_SVG;
					button.title = t("nav.entry");
					button.setAttribute("aria-label", t("nav.entry"));
					button.addEventListener("click", function () { ui.set({ open: true }); });
				}
				// 追加在最后 → 落在那一行的最右侧（「设置」按钮 flex:1，本来就会让位）。
				if (button.parentElement !== row) row.appendChild(button);
				syncRowMode(row);
				watchRow(row);
				// 只有真的变了才通知：ensure 会被 DOM 变动反复叫醒，而 ui.set 本身
				// 也会引起 DOM 变动，无条件写会自己把自己叫成死循环。
				if (ui.get().settingsInjected !== true) ui.set({ settingsInjected: true });
			};

			var schedule = function () {
				if (timer !== null) window.clearTimeout(timer);
				timer = window.setTimeout(function () {
					timer = null;
					ensure();
				}, SIDEBAR_SETTLE_MS);
			};

			ensure();

			if (typeof MutationObserver === "function") {
				observer = new MutationObserver(schedule);
				observer.observe(observeRoot, { childList: true, subtree: true });
			}
			if (typeof ResizeObserver === "function") {
				resizer = new ResizeObserver(schedule);
				if (button !== null && button.parentElement !== null) watchRow(button.parentElement);
			}

			return function () {
				if (observer !== null) observer.disconnect();
				observer = null;
				if (resizer !== null) resizer.disconnect();
				resizer = null;
				resizedRow = null;
				if (timer !== null) window.clearTimeout(timer);
				timer = null;
				unmountButton();
				if (createdStyle !== null && createdStyle.parentElement !== null) {
					createdStyle.parentElement.removeChild(createdStyle);
				}
				createdStyle = null;
			};
		}

		/**
		 * 兜底座位：注入没能完成时才出现的侧栏按钮。
		 *
		 * 只显示图标 —— 文案留在 title / aria-label 里。尺寸、圆角、hover token
		 * 与注入版逐字一致，所以用户在两种情况下看到的是同一个按钮。
		 */
		function SidebarButton(props) {
			var t = props.t;
			var ui = props.ui;
			var [hover, setHover] = useState(false);
			var [injected, setInjected] = useState(function () { return ui.get().settingsInjected === true; });

			useEffect(function () {
				setInjected(ui.get().settingsInjected === true);
				return ui.subscribe(function () { setInjected(ui.get().settingsInjected === true); });
			}, [ui]);

			if (injected) return null;

			return React.createElement("button", {
				type: "button",
				title: t("nav.entry"),
				"aria-label": t("nav.entry"),
				onClick: function () { ui.set({ open: true }); },
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					width: 32, height: 32, padding: 0,
					border: 0, borderRadius: 9,
					background: hover ? T.fill : "transparent",
					color: hover ? T.text1 : T.text2,
					font: "inherit", cursor: "pointer",
					transition: "color 120ms, background 120ms"
				}
			}, React.createElement(Icon, { name: "app", size: 16 }));
		}

		// --------------------------------------------- 标题栏上的小程序栏（Chrome 那一套）
		//
		// 座位是 `conversation.session.header.utilities`：会话头部右侧那一栏，
		// 座位说明的原文是 "Right-aligned Session utilities in ascending order" ——
		// **order 升序即从左到右**。
		//
		// 参考 Chrome 的「扩展程序」那一栏，但**只有一颗按钮**：四个方块的小程序图标，
		// 点开一个下拉面板，面板自上而下是"固定的 / 全部 / 管理小程序"。
		//
		// 这里曾经是两颗（📌 打开固定的那一个 + ▾ 开列表），照搬 Chrome 的分工。
		// 收敛成一颗是因为并排的两颗长得太像：用户看不出"哪颗才是入口"，只会觉得重复。
		// 固定的那一个没丢 —— 它就是面板里的第一行。
		//
		// 面板与 ⋮ 菜单都是 `position: fixed`：它们挂在标题栏上，**不能**参与头部的布局
		// （跟着排会把头部撑高、把页签挤下去），所以坐标是量出来、算出来的（见 barPanelPosition）。

		/** 标题栏右侧那一栏（会话头部）里的座位名。 */
		var BAR_SLOT = "conversation.session.header.utilities";
		/** 这一格的 id。list 座位里用自己**独有**的 id 才是"增加一格"，不是替换别人的格子。 */
		var BAR_ID = "miniapp-bar";
		/**
		 * 必须**小于 0**。
		 *
		 * 同一格里已经有 DSH 自己的日志按钮（`session-log-download`，它没写 order，
		 * 也就是默认的 0），而这一栏按 order 升序**从左到右**排。写成 0 或正数，
		 * 小程序栏就跑到日志按钮右边去了 —— 用户要的是"挨着日志按钮左侧"。
		 */
		var BAR_ORDER = -10;
		/** 面板宽 312（Chrome 那个弹层的量级）、最大高度 420，再高就内部滚动。 */
		var BAR_PANEL_WIDTH = 312;
		var BAR_PANEL_HEIGHT = 420;
		/** 面板与那一栏之间的缝、面板与视口边缘的最小间距。 */
		var BAR_PANEL_GAP = 6;
		var BAR_PANEL_MARGIN = 8;
		/** 量不到那一栏（ref 还没挂上、更老的 DSH）时的兜底坐标：标题栏下面一点、靠右一点。 */
		var BAR_PANEL_FALLBACK = { top: 56, right: 16, w: BAR_PANEL_WIDTH, h: BAR_PANEL_HEIGHT };
		/** ⋮ 菜单：一行三项，比面板窄。 */
		var BAR_MENU_WIDTH = 208;
		var BAR_MENU_HEIGHT = 132;
		var BAR_MENU_FALLBACK = { top: 88, right: 24, w: BAR_MENU_WIDTH, h: BAR_MENU_HEIGHT };
		/** 面板里一行的高度。 */
		var BAR_ROW_HEIGHT = 34;
		/**
		 * 层级：压过抽屉 / 浮窗（46），低于全屏浮层（50）。
		 *
		 * 顺序是有理由的：全屏浮层是"要看完再回来"的模态（它铺满整屏、把头部也盖住了，
		 * 那一栏根本点不到），而这一栏是"边聊边点"的旁挂件；⋮ 菜单又必须压在它自己那个面板之上。
		 */
		var BAR_Z_INDEX = 48;
		var BAR_MENU_Z_INDEX = 49;

		/**
		 * ⋮ 菜单里的三项：「换个地方打开」。
		 *
		 * 与 `LAYOUT_PLACES` 是同一套写法（一张表 = 顺序 + 图标 + 文案键的唯一来源），
		 * 但它**不是**那五个地方：这里的两个 entry 用的是**动词短语**（`bar.open.*`，
		 * "在右侧打开"）而不是 `layout.place.*` 那套名词（"右侧栏"）—— 那排按钮回答
		 * "我现在在哪个坑里"，这里回答"把这一条送到哪里去"。
		 *
		 * 只有三个地方：全屏面板不需要（点这一行本身就是"打开使用"），
		 * 右上浮窗在标题栏这个语境里也不给 —— 面板里那排按钮够用了，菜单越短越不像迷宫。
		 * 三项都复用同一个 `switchLayout`（见那儿），这里不写第二份切换逻辑。
		 */
		var BAR_MENU_ITEMS = [
			{ place: "drawer", icon: "side", labelKey: "bar.open.drawer" },
			{ place: "session", icon: "tab", labelKey: "bar.open.session" },
			{ place: "browser", icon: "browser", labelKey: "actions.openInBrowser" }
		];

		/** 一个正的有限数；不是就退回 fallback。尺寸与坐标都走它，于是**绝不产出 NaN**。 */
		function positiveOr(value, fallback) {
			return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
		}

		/** 一个有限的数（可正可负、可以是 0）；不是就返回 undefined。 */
		function finiteOr(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : undefined;
		}

		/**
		 * 面板两个分区各自要画什么：固定的那**一条记录**（目录里找不到就是 null），
		 * 以及「全部」那一栏的列表。
		 *
		 * 「全部」**就是全部**（含已经固定的那一个）：它顶着「全部小程序」这个标题，
		 * 把它理解成"除固定之外的"就等于让标题说假话。于是固定的那一个会在面板里出现
		 * 两次（固定区一次、全部区一次）—— 这是"固定区 + 全部"这种结构的固有形态，
		 * 不是重复渲染。
		 *
		 * 找不到那一条时返回 `null` 而不是抛：**用户可能只是暂时把它删了**，
		 * 界面上当作"没有固定"，但绝不去改磁盘上那个值（见 MiniAppBar 里的说明）。
		 */
		function splitBarApps(apps, pinnedAppId) {
			var list = Array.isArray(apps) ? apps : [];
			var pinned = null;
			if (typeof pinnedAppId === "string" && pinnedAppId !== "") {
				for (var index = 0; index < list.length; index += 1) {
					var app = list[index];
					if (app !== null && typeof app === "object" && app.miniapp_id === pinnedAppId) {
						pinned = app;
						break;
					}
				}
			}
			return { pinned: pinned, all: list };
		}

		/**
		 * 一个"右对齐到锚点、挂在它下面"的浮层坐标（`position: fixed` 用的 top / right）。
		 *
		 * 面板与 ⋮ 菜单共用这一份算术，只有锚点、尺寸与兜底不同（见下面两个包装）。
		 * 三条硬约束：
		 *  * 量不到锚点（测试的 vm 里没有真 DOM、ref 还没挂上、更老的 DSH）→ 用兜底坐标，
		 *    并且**绝不产出 NaN**；
		 *  * 竖直方向必须夹进视口：面板比剩余空间还高时贴到上边距，绝不画到屏幕外
		 *    （画到屏幕外就等于用户看不到它的下半截，也够不到里面的滚动条）；
		 *  * 锚点下面放不下、而上面放得下时**翻到上面** —— ⋮ 菜单挂在列表最后一行上时
		 *    正是这种情况（不收上来，它就会越过面板底边、甚至越过视口底边）。
		 */
		function anchoredPanelPosition(anchorRect, panelSize, viewport, fallback) {
			var box = panelSize === null || panelSize === undefined ? {} : panelSize;
			var width = positiveOr(box.w, fallback.w);
			var height = positiveOr(box.h, fallback.h);
			var vw = viewport === null || viewport === undefined ? undefined : positiveOr(viewport.width, undefined);
			var vh = viewport === null || viewport === undefined ? undefined : positiveOr(viewport.height, undefined);
			var rect = anchorRect === null || anchorRect === undefined || typeof anchorRect !== "object" ? null : anchorRect;

			var top = fallback.top;
			var right = fallback.right;
			if (rect !== null) {
				var bottom = finiteOr(rect.bottom);
				if (bottom !== undefined) top = bottom + BAR_PANEL_GAP;
				var edge = finiteOr(rect.right);
				// 换算只在 vw 拿得到时做：right 是"从视口右边量到锚点右边"的那段距离。
				if (edge !== undefined && vw !== undefined) right = vw - edge;
			}

			if (vh !== undefined) {
				// 下限与上限分别是"贴住上边距"与"贴住下边距"。视口比面板还矮时上限会低于下限，
				// 取上限（= 上边距）：宁可让它顶在最上面，也不要画出一个够不到底部的浮层。
				var limit = Math.max(BAR_PANEL_MARGIN, vh - height - BAR_PANEL_MARGIN);
				var above = rect === null ? undefined : finiteOr(rect.top);
				var flipped = above === undefined ? undefined : above - BAR_PANEL_GAP - height;
				if (top > limit && flipped !== undefined && flipped >= BAR_PANEL_MARGIN) top = flipped;
				top = Math.max(BAR_PANEL_MARGIN, Math.min(top, limit));
			}
			if (vw !== undefined) {
				// 同理取 max(边距, 上限)：视口比面板还窄时仍然贴住右边，绝不整块跑到左边之外。
				right = Math.max(0, Math.min(right, Math.max(BAR_PANEL_MARGIN, vw - width - BAR_PANEL_MARGIN)));
			}
			if (!Number.isFinite(top)) top = fallback.top;
			if (!Number.isFinite(right)) right = fallback.right;
			return { top: Math.round(top), right: Math.round(right) };
		}

		/** 下拉面板的坐标：右对齐到 ▾、贴在它下面。 */
		function barPanelPosition(buttonRect, panelSize, viewport) {
			return anchoredPanelPosition(buttonRect, panelSize, viewport, BAR_PANEL_FALLBACK);
		}

		/** ⋮ 菜单的坐标：右对齐到那一行的 ⋮、贴在它下面（下面放不下就翻到上面）。 */
		function barMenuPosition(anchorRect, menuSize, viewport) {
			return anchoredPanelPosition(anchorRect, menuSize, viewport, BAR_MENU_FALLBACK);
		}

		/**
		 * 面板的尺寸：宽 312，最大高度 420 —— **两个都再被视口夹一遍**。
		 *
		 * 这个宽度是被设计定的（Chrome 那个弹层就是 300 出头），而"最大高度不超过视口"
		 * 是硬约束：库里有几十个小程序时面板本身要能滚，但它绝不能比屏幕还高。
		 * 返回的是 `maxHeight` 而不是 `height`：里面内容少的时候面板就该矮下来。
		 */
		function barPanelSize(viewport) {
			var vw = viewport === null || viewport === undefined ? undefined : positiveOr(viewport.width, undefined);
			var vh = viewport === null || viewport === undefined ? undefined : positiveOr(viewport.height, undefined);
			var width = vw === undefined ? BAR_PANEL_WIDTH : Math.min(BAR_PANEL_WIDTH, vw - BAR_PANEL_MARGIN * 2);
			var maxHeight = vh === undefined ? BAR_PANEL_HEIGHT : Math.min(BAR_PANEL_HEIGHT, vh - BAR_PANEL_MARGIN * 2);
			return {
				width: Math.round(Math.max(0, width)),
				maxHeight: Math.round(Math.max(0, maxHeight))
			};
		}

		/** 量一个 ref 指向的节点的矩形；量不到返回 null（写法与 `measureConversationRect` 一致）。 */
		function elementRect(ref) {
			try {
				var node = ref === null || ref === undefined ? null : ref.current;
				if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return null;
				return node.getBoundingClientRect();
			} catch (error) {
				return null;
			}
		}

		/**
		 * 这次 mousedown 是不是"点在 selector 指的那些东西之外"。
		 *
		 * 面板与 ⋮ 菜单共用这一条判决，只有 selector 不同：
		 *  * 面板用 `[data-dsh-miniapp-bar]` —— **整条小程序栏**都算"里面"，
		 *    于是点 ▾ 那颗按钮不会被判成"点外面"：先关掉、再被 toggle 打开，
		 *    结果就是"这颗按钮永远关不掉面板"。
		 *  * ⋮ 菜单只认它自己那个菜单 + **这一行**的 ⋮（按 appId 标记）：点面板里别处、
		 *    或者点别的行的 ⋮，这个菜单就该收起来。
		 *
		 * 认不出来的事件一律算"外面"（关掉）：一个连 target 都没有的事件不该把浮层钉在屏幕上。
		 */
		function outsideEvent(event, selector) {
			if (event === null || event === undefined || typeof event !== "object") return true;
			var target = event.target;
			if (target === null || target === undefined || typeof target.closest !== "function") return true;
			try {
				return target.closest(selector) === null;
			} catch (error) {
				return true;
			}
		}

		/** 这次 keydown 是不是 Esc。 */
		function isEscapeKey(event) {
			return event !== null && event !== undefined && typeof event === "object" && event.key === "Escape";
		}

		/**
		 * 一层浮层"怎么关"的共用写法：点外面、按 Esc。
		 *
		 * 两个监听器都在清理时**按同一个函数引用**摘掉 —— 这套代码对泄漏很敏感：
		 * 面板每开一次都会挂一对，摘不干净就会在 window 上越积越多。
		 */
		function useDismiss(active, selector, onClose) {
			useEffect(function () {
				if (active !== true) return undefined;
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				var onMouseDown = function (event) { if (outsideEvent(event, selector)) onClose(); };
				var onKeyDown = function (event) { if (isEscapeKey(event)) onClose(); };
				window.addEventListener("mousedown", onMouseDown);
				window.addEventListener("keydown", onKeyDown);
				return function () {
					if (typeof window.removeEventListener !== "function") return;
					window.removeEventListener("mousedown", onMouseDown);
					window.removeEventListener("keydown", onKeyDown);
				};
			}, [active, selector, onClose]);
		}

		/**
		 * 面板里"整行可点"的一行：⋮ 菜单里的每一项、最下面那条「管理小程序」。
		 */
		function MiniAppActionRow(props) {
			var [hover, setHover] = useState(false);
			return React.createElement("div", Object.assign({
				role: "button", tabIndex: 0,
				title: props.label, "aria-label": props.label,
				onClick: props.onRun,
				onKeyDown: function (event) {
					if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onRun(); }
				},
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					display: "flex", alignItems: "center", gap: 8,
					height: 32, padding: "0 8px", boxSizing: "border-box",
					borderRadius: 8, cursor: "pointer",
					font: "inherit", fontSize: 13, lineHeight: 1,
					color: hover ? T.text1 : T.text2,
					background: hover ? T.hoverSurface : "transparent",
					transition: "color 120ms, background 120ms"
				}
			}, props.attrs),
				React.createElement(Icon, { name: props.icon, size: 14, stroke: props.stroke === true }),
				React.createElement("span", {
					style: {
						flex: "1 1 auto", minWidth: 0, overflow: "hidden",
						textOverflow: "ellipsis", whiteSpace: "nowrap"
					}
				}, props.label)
			);
		}

		/**
		 * 一行末尾的 ⋮ 菜单：「换个地方打开」。
		 *
		 * 它是**第二层**浮层（压在面板上面），所以层级高一档、坐标也自己量一遍。
		 * 关掉的路径与面板一样是"点外面 / Esc"，但"外面"只算这一行之外（见 `outsideEvent`）。
		 *
		 * 与面板同一条已知边界：Esc 会同时被面板那层和这一层收到，两层一起关。
		 * 这是**有意的**（Chrome 里 Esc 也是把整个弹层收掉），不是漏判。
		 */
		function MiniAppBarMenu(props) {
			var t = props.t;
			var viewport = viewportSize();
			var position = barMenuPosition(elementRect(props.anchorRef), { w: BAR_MENU_WIDTH, h: BAR_MENU_HEIGHT }, viewport);
			// "外面"由调用方给：它比这一层更清楚该把哪些东西算作"里面"（见 MiniAppBarRow）。
			useDismiss(true, props.dismissSelector, props.onClose);

			return React.createElement("div", {
				role: "menu",
				"aria-label": t("bar.menu"),
				"data-dsh-miniapp-bar-menu": props.appId,
				style: {
					position: "fixed", top: position.top, right: position.right,
					width: BAR_MENU_WIDTH, zIndex: BAR_MENU_Z_INDEX,
					padding: 4, boxSizing: "border-box",
					background: T.bgLayer1, border: "1px solid " + T.border2,
					borderRadius: 12, boxShadow: "0 14px 36px rgba(0,0,0,0.20)"
				}
			}, BAR_MENU_ITEMS.map(function (item) {
				return React.createElement(MiniAppActionRow, {
					key: item.place,
					icon: item.icon,
					label: t(item.labelKey),
					attrs: { role: "menuitem", "data-dsh-miniapp-bar-place": item.place },
					onRun: function () { props.onSwitch(item.place, props.appId); }
				});
			}));
		}

		/**
		 * 面板里的一行：图标 + 名字 + 📌 + ⋮。
		 *
		 * 行本身可点 = **打开它**（与左边那颗按钮同一个动作、同一个 `switchLayout("panel", …)`）。
		 * 后面那两枚是行内的独立控件，所以它们裹在一层挂了 `stopPropagation` 的容器里 ——
		 * 否则点 📌 会连带把这一行也"打开"了。**click 与 keydown 都要拦**：
		 * 焦点在 📌 上按回车时，事件同样会冒泡到这一行。
		 *
		 * 返回值是一个**数组**（行 + 它自己那个 ⋮ 菜单）：菜单是 `position: fixed` 的浮层，
		 * 塞进这一行只会多一层要处理的冒泡，而包一层 Fragment 又只是个空壳。
		 *
		 * ⋮ 菜单开在哪一行是**这一行自己的状态**：两行同时开着菜单是不该出现的画面，
		 * 而"点另一行的 ⋮ 就把这一行收掉"由 mousedown 那条判决保证（见 outsideEvent）。
		 */
		function MiniAppBarRow(props) {
			var t = props.t;
			var app = props.app;
			var pinned = props.pinned === true;
			var [menuOpen, setMenuOpen] = useState(false);
			var menuRef = useRef(null);
			var icon = String(app.icon === null || app.icon === undefined ? "" : app.icon).trim();
			var label = t("bar.openPinned", { name: app.name });
			var run = function () { props.onOpen(app.miniapp_id); };
			// 这一行的 ⋮ 的标记：菜单那层"点外面"要把它一起算进"里面"，
			// 否则点自己那颗 ⋮ 会先关掉、再被 toggle 打开 —— 永远关不掉。
			var anchorSelector = "[data-dsh-miniapp-bar-menu], [data-dsh-miniapp-bar-menu-anchor=" + JSON.stringify(app.miniapp_id) + "]";

			var row = React.createElement("div", {
				// 数组里返回的两个兄弟都要有 key（React 对数组子元素的要求）。
				key: "row",
				role: "button", tabIndex: 0,
				title: label, "aria-label": label,
				// 给测试与真机排障一个稳定的抓手（不用去猜第几行）。
				"data-dsh-miniapp-bar-row": app.miniapp_id,
				onClick: run,
				onKeyDown: function (event) {
					if (event.key === "Enter" || event.key === " ") { event.preventDefault(); run(); }
				},
				style: {
					display: "flex", alignItems: "center", gap: 8,
					height: BAR_ROW_HEIGHT, padding: "0 2px 0 8px", boxSizing: "border-box",
					borderRadius: 10, cursor: "pointer"
				}
			},
				React.createElement("span", {
					"aria-hidden": "true",
					style: {
						display: "grid", placeItems: "center", width: 20, height: 20,
						flex: "0 0 auto", fontSize: 14, lineHeight: 1, color: T.brand
					}
				}, icon.length > 0 ? icon : React.createElement(Icon, { name: "app", size: 14 })),
				React.createElement("span", {
					style: {
						flex: "1 1 auto", minWidth: 0, overflow: "hidden",
						textOverflow: "ellipsis", whiteSpace: "nowrap",
						fontSize: 13, color: T.text1
					}
				}, app.name),
				React.createElement("div", {
					onClick: function (event) { event.stopPropagation(); },
					onKeyDown: function (event) { event.stopPropagation(); },
					style: { display: "flex", flex: "0 0 auto", alignItems: "center", gap: 2 }
				},
					React.createElement(CardAction, {
						// 实心 = 已固定，空心 = 还没固定：同一个几何的两态，不是"变淡"。
						icon: pinned ? "pin" : "pinOutline",
						stroke: pinned !== true,
						label: pinned ? t("bar.unpin") : t("bar.pin"),
						attrs: {
							"data-dsh-miniapp-bar-part": "pin",
							"aria-pressed": pinned ? "true" : "false"
						},
						onRun: function () { props.onPin(app.miniapp_id); }
					}),
					React.createElement(CardAction, {
						icon: "dots",
						label: t("bar.menu"),
						nodeRef: menuRef,
						attrs: {
							"data-dsh-miniapp-bar-part": "menu",
							"data-dsh-miniapp-bar-menu-anchor": app.miniapp_id,
							"aria-haspopup": "menu",
							"aria-expanded": menuOpen ? "true" : "false"
						},
						onRun: function () { setMenuOpen(!menuOpen); }
					})
				)
			);

			return [
				row,
				menuOpen ? React.createElement(MiniAppBarMenu, {
					key: "menu",
					t: t, appId: app.miniapp_id, anchorRef: menuRef,
					onSwitch: props.onSwitch,
					// 这一层只收自己：Esc 时面板那层也会关（见 MiniAppBarMenu 的说明）。
					onClose: function () { setMenuOpen(false); },
					dismissSelector: anchorSelector
				}) : null
			];
		}

		/**
		 * 下拉面板。
		 *
		 * 自上而下：标题行（小程序 + ✕）、固定的小程序、全部小程序、分隔线、管理小程序。
		 *
		 * 四种身体状态各有各的话，**都不留天窗**：
		 *  * 目录读失败 → 一条错误（它比"空"更该说清楚，否则用户以为自己的小程序没了）；
		 *  * 还在读 → `list.loading`；
		 *  * 真的一条都没有 → `bar.empty`（并指向最下面那个入口）；
		 *  * 有内容 → 两个分区；固定区为空时用 `bar.emptyPinned` 顶一行 —— 分区标题不能开着天窗。
		 */
		function MiniAppBarPanel(props) {
			var t = props.t;
			var catalog = useCatalog();
			var prefsState = usePrefs();
			var viewport = viewportSize();
			var size = barPanelSize(viewport);
			var position = barPanelPosition(elementRect(props.anchorRef), { w: size.width, h: size.maxHeight }, viewport);
			var sections = splitBarApps(catalog.apps, prefsState.pinnedAppId);

			// 点面板外面 / 按 Esc 都关掉。"里面"算整条小程序栏（见 outsideEvent）。
			useDismiss(true, "[data-dsh-miniapp-bar]", props.onClose);

			var openApp = function (appId) {
				props.onClose();
				switchLayout("panel", appId, { t: t, ctx: props.ctx });
			};
			var runPlace = function (place, appId) {
				props.onClose();
				switchLayout(place, appId, { t: t, ctx: props.ctx });
			};
			var pin = function (appId) {
				// 乐观更新在 `prefs.pin` 里（那颗图标要跟着手指走），失败自己回滚，
				// 所以这里既不 await 也不弹错：一个固定不上不该打断用户手上的事。
				void prefs.pin(appId);
			};
			var manage = function () {
				props.onClose();
				// 「管理小程序」= 整个小程序库，也就是全屏浮层里那个库页面。
				// 这里**不写第二份打开逻辑**：库页面就是 `ui.open` 那一份状态
				// （也不走 `switchLayout("panel", …)` —— 那条路的 appId 是必填的，
				// 空 id 会被它当场拒绝，而这里要打开的是"库"，不是某一个小程序）。
				if (props.ui !== undefined && props.ui !== null && typeof props.ui.set === "function") {
					props.ui.set({ open: true });
				}
			};

			/** 一条说明文字（加载中 / 出错 / 空态）。 */
			var note = function (text, color) {
				return React.createElement("div", {
					role: "status",
					style: Object.assign({}, TEXT3, {
						padding: "8px 10px", fontSize: 12, lineHeight: "17px",
						color: color === undefined ? T.text2 : color
					})
				}, text);
			};
			/** 一个分区标题：12px + `T.caption`，与 DSH 自己那一档小字一致。 */
			var title = function (text) {
				return React.createElement("div", {
					style: {
						padding: "6px 10px 2px", fontSize: 12, lineHeight: "16px",
						fontWeight: 600, color: T.caption
					}
				}, text);
			};
			var row = function (app, isPinned, key) {
				return React.createElement(MiniAppBarRow, {
					key: key, t: t, app: app, pinned: isPinned,
					onOpen: openApp, onPin: pin, onSwitch: runPlace
				});
			};

			var body = [];
			if (catalog.error !== null) {
				body.push(note(t("errors.loadListFailed", { message: catalog.error }), T.danger));
			} else if (catalog.loaded !== true || catalog.loading === true) {
				body.push(note(t("list.loading"), undefined));
			} else if (catalog.apps.length === 0) {
				body.push(note(t("bar.empty"), undefined));
			} else {
				body.push(title(t("bar.sectionPinned")));
				body.push(sections.pinned === null
					? note(t("bar.emptyPinned"), undefined)
					: row(sections.pinned, true, "pinned"));
				body.push(title(t("bar.sectionAll")));
				for (var index = 0; index < sections.all.length; index += 1) {
					body.push(row(sections.all[index], sections.all[index] === sections.pinned, "all-" + index));
				}
			}

			return React.createElement("div", {
				role: "dialog",
				"aria-label": t("bar.title"),
				"data-dsh-miniapp-bar-panel": "",
				style: {
					position: "fixed", top: position.top, right: position.right,
					width: size.width, maxHeight: size.maxHeight,
					zIndex: BAR_Z_INDEX,
					display: "flex", flexDirection: "column",
					boxSizing: "border-box", overflow: "hidden",
					background: T.bgLayer1,
					border: "1px solid " + T.border2,
					borderRadius: 14,
					boxShadow: "0 18px 48px rgba(0,0,0,0.22)"
				}
			},
				// 标题行。
				React.createElement("div", {
					style: {
						flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8,
						height: 40, padding: "0 8px 0 12px", boxSizing: "border-box",
						borderBottom: "1px solid " + T.border1
					}
				},
					React.createElement("span", {
						style: {
							flex: "1 1 auto", minWidth: 0, overflow: "hidden",
							textOverflow: "ellipsis", whiteSpace: "nowrap",
							fontSize: 13, fontWeight: 600, color: T.text1
						}
					}, t("bar.title")),
					React.createElement(CardAction, {
						icon: "close",
						label: t("actions.close"),
						attrs: { "data-dsh-miniapp-bar-part": "close" },
						onRun: props.onClose
					})
				),
				// 列表（自己滚，不动面板的头与脚）。
				React.createElement("div", {
					style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "4px 6px 8px" }
				}, body),
				// 最下面那条：整个小程序库的入口。
				React.createElement("div", {
					style: {
						flex: "0 0 auto", padding: 6,
						borderTop: "1px solid " + T.border1
					}
				},
					React.createElement(MiniAppActionRow, {
						icon: "gear",
						stroke: true,
						label: t("bar.manage"),
						attrs: { "data-dsh-miniapp-bar-part": "manage" },
						onRun: manage
					})
				)
			);
		}

		/**
		 * 标题栏上的小程序入口：**一颗**按钮 + 它那个下拉面板。
		 *
		 * 按钮画的是四个方块（`Icon` 的 `app`，与侧栏入口同一几何），点它开合面板 ——
		 * 面板自上而下是"固定的 / 全部 / 管理小程序"，所以"打开我固定的那一个"是
		 * 面板里的第一行，而不是标题栏上第二颗按钮。
		 *
		 * 固定的那一个已经不在目录里（被删了）：面板会照旧画"固定的"分区标题 + 一句
		 * 空态（见 `MiniAppBarPanel`），但**绝不去改 prefs** —— 用户可能只是暂时删了它，
		 * 下次再建一个同 id 的（或者他改主意了）就该原样回来。
		 */
		function MiniAppBar(props) {
			var t = props.t;
			var ctx = props.ctx;
			var catalog = useCatalog();
			var [open, setOpen] = useState(false);
			var barRef = useRef(null);

			// 目录没拉过就拉一次（与浮层同一条写法，同一个理由）：面板里要列出全部小程序，
			// 而用户完全可能一进 DSH 就直接点这颗按钮 —— 那一刻目录可能压根没被拉过。
			useEffect(function () {
				if (catalog.loaded === true || catalog.loading === true) return;
				void appCatalog.load(false);
			}, [catalog.loaded, catalog.loading]);

			var close = useCallback(function () { setOpen(false); }, []);

			return React.createElement("div", {
				// 整条栏（含面板）的标记：外面点击那条判决按它认"里面"。
				"data-dsh-miniapp-bar": "",
				ref: barRef,
				// `flex: "0 0 auto"`：头部挤的时候该被压缩的是别的东西，不是这颗按钮。
				style: { display: "flex", alignItems: "center", gap: 2, flex: "0 0 auto" }
			},
				React.createElement(ToolbarAction, {
					label: t("bar.entry"),
					content: React.createElement(Icon, { name: "app", size: 16 }),
					attrs: {
						"data-dsh-miniapp-bar-part": "entry",
						// 弹层本身的 role 是 dialog，所以这里照 ARIA 1.2 给同一个值
						// （不是那个约等于 menu 的 "true"）。
						"aria-haspopup": "dialog",
						"aria-expanded": open ? "true" : "false"
					},
					onRun: function () { setOpen(!open); }
				}),
				open ? React.createElement(MiniAppBarPanel, {
					t: t, ctx: ctx, ui: props.ui, anchorRef: barRef, onClose: close
				}) : null
			);
		}

		// ------------------------------------------------------------------ apply

		function apply(ctx) {
			try {
				ctx.effect(function () {
					return ctx.locale.register(NS, {
						zh: flattenCopy(COPY.zh),
						en: flattenCopy(COPY.en)
					});
				}, "dsh-miniapp: settings copy");

				var t = ctx.locale.bind(NS);
				// `ui` 是模块级那一份（见它旁边的说明）；这里**不再新建** ——
				// 新建一份会让组件写进去的位置与座位读到的开关分家。

				// 「小程序」按钮要长在设置栏右侧（[设置][小程序]）。`sidebar.settings`
				// 是 single 槽位、注册会替换掉设置按钮本身，所以这里走 DOM 注入 ——
				// 与 DSH Desktop 自己的「连接移动设备」同一条路。
				ctx.effect(function () {
					return mountSidebarEntry(ui, t);
				}, "dsh-miniapp: sidebar entry");

				// 三个 composer 座位共享同一份模式状态与同一个会话语言读取口。
				// inject 是**接收 sessionId 的工厂**（DSH 的槽位契约），所以每个会话拿到的
				// 是同一份 store + 同一个 t / locale 面。
				var modeStore = new MiniAppModeStore();
				var composerInject = function () {
					return {
						mode: modeStore,
						localeOf: function () { return ctx.locale.getLocale().active; }
					};
				};

				// 模式 chip 与「你选了什么」：同一格座位（输入工具行左侧）里的**两格**。
				//
				// 两格各自 `inject` 一次，而不是一次注册两个（`inject` 的回调确实可以返回
				// disposer 数组）：两条登记的生命周期互不相干，将来要摘掉其中一条时，
				// 不需要动另一条。order 差 1，保证 chip 恒在选中态左边。
				ctx.slots.inject(COMPOSER_SLOTS.left, function () {
					return ctx.slots.register({
						name: COMPOSER_SLOTS.left,
						id: MODE_CHIP_ID,
						order: COMPOSER_ORDER,
						locale: NS,
						inject: composerInject
					}, MiniAppModeChipSeat);
				});

				ctx.slots.inject(COMPOSER_SLOTS.left, function () {
					return ctx.slots.register({
						name: COMPOSER_SLOTS.left,
						id: SELECTION_CHIP_ID,
						order: COMPOSER_ORDER + 1,
						locale: NS,
						inject: composerInject
					}, MiniAppSelectionChipSeat);
				});

				// 模板面板：铺在输入卡片**上方**（`conversation.input.dock`）。
				//
				// 位置从"卡片下方"变成"卡片上方"是被座位契约逼出来的，不是审美决定：
				// 卡片下方那一格（`conversation.composer.dock`）只在非空白会话渲染，
				// 而面板是给空白会话用的。这一格（输入卡片上方那整行）在空白会话也渲染，
				// 而且渲染点在 hero 分支之外、面板的量高逻辑用到的那两个 DOM 标记
				// （`[data-composer-seat]` / `[data-composer-card]`）都还在它的祖先/兄弟里。
				ctx.slots.inject(COMPOSER_SLOTS.dock, function () {
					return ctx.slots.register({
						name: COMPOSER_SLOTS.dock,
						id: PANEL_ID,
						order: COMPOSER_ORDER,
						locale: NS,
						inject: composerInject
					}, MiniAppTemplatePanel);
				});

				// 「创建小程序」意图的落地座位：与面板同一格座位、**另一格 id**。
				// 它只消费、不渲染，可见条件是"有一份待落地的意图"，与面板的"模式开着"
				// 完全是两回事 —— 混在一格会让其中一个的返回值决定另一个的去留。
				ctx.slots.inject(CREATE_DRAFT_SLOT, function () {
					return ctx.slots.register({
						name: CREATE_DRAFT_SLOT,
						id: CREATE_DRAFT_ID,
						order: CREATE_DRAFT_ORDER,
						locale: NS,
						// 交出去的只有意图 store 与 ui：那一格不需要任何业务 props，
						// `session` / `sessionId` / `inputActions` 都是 DSH 给的标准 props。
						// ui 是给降级提示用的 —— 浮层已经关了，只有 toast 看得见。
						inject: function () { return { intent: createIntent, ui: ui }; }
					}, MiniAppCreateDraftSeat);
				});

				ctx.slots.inject("sidebar.footer.action", function () {
					return ctx.slots.register({
						name: "sidebar.footer.action",
						id: "miniapp",
						order: 50,
						locale: NS,
						inject: function () { return { ui: ui }; }
					}, SidebarButton);
				});

				ctx.slots.inject("shell.overlay", function () {
					return ctx.slots.register({
						name: "shell.overlay",
						id: "miniapp",
						order: 50,
						locale: NS,
						// ctx 也要交出去：运行页工具栏上那排「切换布局」需要它去取当前会话 id、
						// 并调用 uiConversation 把页签切过去（见 switchLayout）。
						inject: function () { return { ui: ui, ctx: ctx }; }
					}, MiniAppOverlaySeat);
				});

				// 标题栏右侧那一栏：小程序栏（固定的那一颗 + ▾ + 下拉面板）。
				//
				// `conversation.session.header.utilities` 是 `kind: "list"` + `scope: "session"`
				// 的正规座位（replaceRisk: "none"），用自己的 id 加一格就是"增加"，
				// 不会顶掉同一格里 DSH 自己的日志按钮。order 必须 < 0，理由见 BAR_ORDER。
				//
				// 它默认就注册（不像会话页签那样按需）：这颗按钮**永远**该在，
				// 哪怕一次都没用过小程序 —— 它就是那个入口。
				ctx.slots.inject(BAR_SLOT, function () {
					return ctx.slots.register({
						name: BAR_SLOT,
						id: BAR_ID,
						order: BAR_ORDER,
						locale: NS,
						// ui 要交出去：「管理小程序」打开的是全屏浮层那份库页面（`ui.open`）。
						inject: function () { return { ctx: ctx, ui: ui }; }
					}, MiniAppBar);
				});

				// 会话页签：会话头部那一排里多一格「小程序」。
				//
				// `conversation.view` 是 list + scope session 的正规座位（DSH 用
				// `slots.entries("conversation.view")` 画页签、只渲染激活那一个的身体），
				// 所以用自己独有的 id 添一格是"增加"，不是"替换别人的格子"。
				//
				// label 写成**返回函数**而不是当场求值的字符串：DSH 每次投影页签都会
				// 重新读一遍（`resolveSlotLabel(entry.options.label)`），于是切语言时
				// 页签文字跟着走，不需要重新注册。
				// **默认不注册**，只把"怎么注册"装好（见 syncViewTab）：一注册，
				// 每个会话的头部都会多出这一格，而绝大多数会话用不到它。
				// 点「在本会话页签打开」时才登记，最后一个用它的会话关掉后自动撤销。
				registerViewTab = function () {
					return ctx.slots.inject(VIEW_SLOT, function () {
						return ctx.slots.register({
							name: VIEW_SLOT,
							id: VIEW_ID,
							order: VIEW_ORDER,
							locale: NS,
							label: function () { return t("view.tab"); },
							inject: function () { return { ctx: ctx }; }
						}, MiniAppSessionView);
					});
				};

				// DSH 原生右栏（方案 B 的"并列"那一面）：**登记一次、常驻**。
				//
				// 与「会话页签」不同，这里不需要按需登记：`sidebar.right.pane.tab` 是 keyed
				// 座位，我们只是**加了一格**（不顶掉 DSH 自己的 Files / 预览）；而 tab 类型
				// 必须先注册，否则用户从右栏里根本找不到「小程序」这个入口。
				//
				// 服务拿不到时**不注册 tab 类型**（老 DSH），但正文那一格照常登记 —— 它是纯加法，
				// DSH 不显示就没人看见；这样"服务缺失"这件事只影响能力，不影响别的东西。
				ctx.effect(function () {
					var disposers = [];
					disposers.push(ctx.slots.inject(RIGHTBAR_PANE_SLOT, function () {
						return ctx.slots.register({
							name: RIGHTBAR_PANE_SLOT,
							// `id` 与 `key` 都写同一个值：`id` 是所有登记共有的不变量（同座位内不得重复），
							// `key` 是 keyed 座位的判别式 —— 这里它们恰好是同一件事，写两遍是有意的。
							id: RIGHTBAR_VIEW_ID,
							// key 必须**逐字等于** tab 类型的 id —— 这一格就是那个类型的内容。
							key: RIGHTBAR_VIEW_ID,
							locale: NS,
							inject: function () { return { ctx: ctx, ui: ui }; }
						}, MiniAppRightbarPane);
					}));
					var tabs = rightbarTabsService(ctx);
					if (tabs !== null && typeof tabs.register === "function") {
						try {
							tabs.register({ id: RIGHTBAR_VIEW_ID, kind: RIGHTBAR_VIEW_KIND, priority: RIGHTBAR_VIEW_PRIORITY });
						} catch (error) {
							// 重复 id 会抛（DSH 有意如此）；那是"已经登记过了"，不是致命错。
							console.error("[dsh-miniapp] rightbar tab register failed:", error);
						}
					}
					return function () {
						for (var index = 0; index < disposers.length; index += 1) {
							if (typeof disposers[index] === "function") disposers[index]();
						}
					};
				}, "dsh-miniapp: rightbar pane");
			} catch (error) {
				console.error("[dsh-miniapp] client half failed to load (host half unaffected):", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		// 以下导出只为让测试能直接契约到模式状态机、座位常量与各座位的可见条件，
		// DSH 自己只会用 apply / inject / name。
		exports.COMPOSER_SLOTS = COMPOSER_SLOTS;
		exports.MODE_CHIP_ID = MODE_CHIP_ID;
		exports.SELECTION_CHIP_ID = SELECTION_CHIP_ID;
		exports.PANEL_ID = PANEL_ID;
		exports.COMPOSER_ORDER = COMPOSER_ORDER;
		// 「创建小程序」直达链路：意图 store、那一格的座位常量、消费组件，以及
		// 那句必须与宿主半边逐字一致的草稿与技能名（测试钉住这条跨半边的一致性）。
		exports.MiniAppCreateIntent = MiniAppCreateIntent;
		// 库视图也露出来：两个创建入口（空态那颗与工具栏那颗）是不是**同一个回调**、
		// 点下去是不是真的调用它，只有把这一层单独渲染一次才看得见。
		exports.LibraryView = LibraryView;
		exports.createIntent = createIntent;
		exports.MiniAppCreateDraftSeat = MiniAppCreateDraftSeat;
		exports.CREATE_DRAFT_SLOT = CREATE_DRAFT_SLOT;
		exports.CREATE_DRAFT_ID = CREATE_DRAFT_ID;
		exports.CREATE_DRAFT_ORDER = CREATE_DRAFT_ORDER;
		exports.CREATE_DRAFT = CREATE_DRAFT;
		exports.CREATE_SKILL_NAME = CREATE_SKILL_NAME;
		exports.MiniAppModeStore = MiniAppModeStore;
		exports.MiniAppModeChipSeat = MiniAppModeChipSeat;
		exports.MiniAppSelectionChipSeat = MiniAppSelectionChipSeat;
		exports.MiniAppTemplatePanel = MiniAppTemplatePanel;
		exports.MiniAppTemplateCard = MiniAppTemplateCard;
		exports.writeInputDraft = writeInputDraft;
		exports.mountSidebarEntry = mountSidebarEntry;
		exports.SIDEBAR_ICON_SVG = SIDEBAR_ICON_SVG;
		exports.SIDEBAR_CSS = SIDEBAR_CSS;
		exports.templateFace = templateFace;
		exports.templateCategoryLabel = templateCategoryLabel;
		exports.TEMPLATE_CATEGORY_KEYS = TEMPLATE_CATEGORY_KEYS;
		// 同一枚主按钮的两种写法（函数组件 / 内联常量）都露出来，
		// 这样"它们必须一致"可以是被断言的事实，而不是一句注释里的承诺。
		exports.PrimaryButton = PrimaryButton;
		exports.INLINE_PRIMARY = INLINE_PRIMARY;
		exports.INLINE_DANGER = INLINE_DANGER;
		// 瀑布流的几何：公式与列数都被测试钉着，所以常量也得露出来。
		exports.PANEL_COLUMNS = PANEL_COLUMNS;
		exports.PANEL_GRID_GAP = PANEL_GRID_GAP;
		// 预览量高协议的两端各自是纯函数，露出来才能在不启动浏览器的前提下单测。
		exports.PREVIEW_MESSAGE_TYPE = PREVIEW_MESSAGE_TYPE;
		exports.PREVIEW_MIN_HEIGHT = PREVIEW_MIN_HEIGHT;
		exports.PREVIEW_MAX_HEIGHT = PREVIEW_MAX_HEIGHT;
		exports.PREVIEW_LOGICAL_WIDTH = PREVIEW_LOGICAL_WIDTH;
		exports.PREVIEW_LOGICAL_HEIGHT = PREVIEW_LOGICAL_HEIGHT;
		exports.previewMeasureScript = previewMeasureScript;
		exports.withPreviewMeasure = withPreviewMeasure;
		exports.previewHeightFromMessage = previewHeightFromMessage;
		exports.previewDisplayHeight = previewDisplayHeight;
		// 会话页签：座位契约、按会话分片的选中态，以及"从别处切过去"那条路。
		// `focusSessionViewTab` / `findSessionViewTab` 要操作 DOM（按文字找页签），
		// 露出来才能在单测里注入一个假 document 把"找到 / 已选中 / 找不到"三条都测一遍；
		// `currentSessionId` / `openInSession` 同理。
		exports.VIEW_SLOT = VIEW_SLOT;
		exports.VIEW_ID = VIEW_ID;
		exports.VIEW_ORDER = VIEW_ORDER;
		exports.MiniAppSessionView = MiniAppSessionView;
		exports.MiniAppSessionStore = MiniAppSessionStore;
		exports.sessionViewStore = sessionViewStore;
		exports.focusSessionViewTab = focusSessionViewTab;
		exports.currentSessionId = currentSessionId;
		exports.openInSession = openInSession;
		exports.closeInSession = closeInSession;
		exports.syncViewTab = syncViewTab;
		// DSH 原生右栏（方案 B 第一期）：常量、读回、四步委派，以及那一格的正文组件。
		// 全部露出来 —— 这一期的价值就是"接线被断言住"，而这些断言都是在没有真 DSH、
		// 没有浏览器的情况下跑的，所以入口必须可达。
		exports.RIGHTBAR_PANE_SLOT = RIGHTBAR_PANE_SLOT;
		exports.RIGHTBAR_VIEW_ID = RIGHTBAR_VIEW_ID;
		exports.RIGHTBAR_VIEW_KIND = RIGHTBAR_VIEW_KIND;
		exports.observeRightbar = observeRightbar;
		exports.openRightbarPane = openRightbarPane;
		exports.floatRightbarPane = floatRightbarPane;
		exports.dockRightbarPane = dockRightbarPane;
		exports.setRightbarPaneExpanded = setRightbarPaneExpanded;
		exports.closeRightbarPane = closeRightbarPane;
		exports.MiniAppRightbarPane = MiniAppRightbarPane;
		exports.setRegisterViewTab = function (fn) { registerViewTab = fn; };
		exports.findSessionViewTab = findSessionViewTab;
		// 目录（三处运行面共用一份列表）也露出来：测试要能把它的快照种进去。
		exports.MiniAppCatalog = MiniAppCatalog;
		exports.appCatalog = appCatalog;
		// 跨座位状态本身也露出来：测试要能直接读。（原来还写"拖动 / 缩放的落点是写进它的" ——
		// 那两个落点随自绘浮窗一起退役了，现在它只记"哪一个面开着、跑的是哪个 id"。）
		exports.ui = ui;
		// 浮层渲染口。**自绘浮窗的地基已经不在这里**：`MiniAppFloatingRunner` 与它那 9 个
		// 几何纯函数、`ResizeGrip`、几何常量、`cornerPosition`/`cornerSize` 全部退役
		// （DSH 原生右栏 + `float()` 接手）。这一条与它的导出一起删掉是**有意的**：
		// 留着 `exports.X = undefined` 只会让"我们还在画窗口"这件事看起来还在。
		exports.MiniAppOverlaySeat = MiniAppOverlaySeat;
		// 运行页的两套 postMessage 协议常量。**它们不是自绘浮窗的一部分**，所以留：
		// `EMBED_QUERY` / `RUNNER_HEIGHT_MESSAGE_TYPE` + `cornerFrameUrl`（serve URL 拼接，
		// `openInBrowser` 与浏览器那一面在用，名字里的 corner 是历史遗留）
		// 与 `runnerHeightFromMessage`（embed 量高协议的客户端一半，宿主半边仍在注入量高脚本）。
		// 这三个名字都带 corner/runner，但都不是"自绘窗口的几何" —— 按名字批量删会当场崩。
		exports.EMBED_QUERY = EMBED_QUERY;
		exports.RUNNER_HEIGHT_MESSAGE_TYPE = RUNNER_HEIGHT_MESSAGE_TYPE;
		exports.cornerFrameUrl = cornerFrameUrl;
		exports.runnerHeightFromMessage = runnerHeightFromMessage;
		exports.RunnerView = RunnerView;
		// 「切换布局」：五枚按钮那一排、它背后那张表，以及"点下去做什么"那一个函数。
		// 全部露出来，测试才能**遍历那五个地方**去断言"五个都在、顺序固定、每一枚都有
		// 文案与图标、点下去真的切对了地方"，而不是只钉住其中一枚的形状。
		exports.LAYOUT_PLACES = LAYOUT_PLACES;
		// 呈现模式的**语义**也露出来：第二期（接 DSH 原生 rightbar 的 float/dock）要用它做
		// "这一步成不成"的判定；它同时让"不得把 undefined 当成功"这条语义可以在没有浏览器、
		// 没有 sidebarRight 的情况下被断言 —— 否则这条语义只能活在注释里。
		exports.PRESENTATION_MODES = PRESENTATION_MODES;
		exports.presentationStep = presentationStep;
		exports.LAYOUT_SWITCH_SIZE = LAYOUT_SWITCH_SIZE;
		exports.LAYOUT_SWITCH_GAP = LAYOUT_SWITCH_GAP;
		exports.layoutSwitcherWidth = layoutSwitcherWidth;
		exports.findLayoutPlace = findLayoutPlace;
		exports.LayoutSwitcher = LayoutSwitcher;
		exports.LayoutSwitchButton = LayoutSwitchButton;
		exports.switchLayout = switchLayout;
		// 标题栏上的小程序栏：座位、几何（面板定位与尺寸都是纯函数）、固定逻辑，
		// 以及那几个组件 —— 露出来才能在不启动浏览器的前提下把"点开 / 关掉 / 固定 / 换地方"
		// 这几条路真的走一遍。
		exports.BAR_SLOT = BAR_SLOT;
		exports.BAR_ID = BAR_ID;
		exports.BAR_ORDER = BAR_ORDER;
		exports.BAR_MENU_ITEMS = BAR_MENU_ITEMS;
		exports.BAR_PANEL_WIDTH = BAR_PANEL_WIDTH;
		exports.BAR_PANEL_HEIGHT = BAR_PANEL_HEIGHT;
		exports.BAR_MENU_WIDTH = BAR_MENU_WIDTH;
		exports.BAR_Z_INDEX = BAR_Z_INDEX;
		exports.BAR_MENU_Z_INDEX = BAR_MENU_Z_INDEX;
		exports.barPanelPosition = barPanelPosition;
		exports.barMenuPosition = barMenuPosition;
		exports.barPanelSize = barPanelSize;
		exports.outsideEvent = outsideEvent;
		exports.isEscapeKey = isEscapeKey;
		exports.splitBarApps = splitBarApps;
		exports.MiniAppBar = MiniAppBar;
		exports.MiniAppBarPanel = MiniAppBarPanel;
		exports.MiniAppBarRow = MiniAppBarRow;
		exports.MiniAppBarMenu = MiniAppBarMenu;
		// 固定（走宿主的 /prefs）：判决、响应解析与那一份模块级状态。
		exports.MiniAppPrefs = MiniAppPrefs;
		exports.prefs = prefs;
		exports.pinAfterToggle = pinAfterToggle;
		exports.readPinnedId = readPinnedId;
		exports.openInBrowser = openInBrowser;
		exports.TOAST_Z_INDEX = TOAST_Z_INDEX;
		exports.ICON_PATHS = ICON_PATHS;
		return module.exports;
	}
});
