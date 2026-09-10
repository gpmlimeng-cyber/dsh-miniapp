// dsh-miniapp — 客户端半边。
//
// 手写成 DSH 的 `__ModuleLoader__` 形态，因此无需任何构建步骤：宿主直接加载
// 这个文件。只依赖 `react`（`require("react")`），样式全部走主题 token 内联，
// 这样深浅色主题自动跟随、也不会与设计系统漂移。
//
// 侧栏入口：注入一个 32×32 的描边图标按钮，插进设置栏那一行（[设置][小程序]），
// 与 DSH Desktop 自己的「连接移动设备」并列 —— 那是个 single 槽位，所以走 DOM 注入。
// `sidebar.footer.action` 上的注册保留为兜底：注入成功时它自己让位。
//
// 六处座位：
//   * `sidebar.footer.action`       —— 侧栏「小程序」入口（**兜底**，注入成功时不出现）；
//   * `shell.overlay`               —— **三个互斥浮层**共用这一个座位：全屏浮层（库页面
//                                      与运行页）、右侧抽屉、会话右上角浮窗；
//   * `conversation.view`           —— 会话头部页签里的「小程序」一格（**会话主体**，
//                                      占满会话区；它不是浮层，也不参与互斥）；
//   * `conversation.hero.modeActions`   —— 空白会话 hero 上的「小程序」chip；
//   * `conversation.input.accessory`    —— 输入框旁的同一个 chip（只在空白会话出现）；
//   * `conversation.composer.dock`      —— 进入模式后铺在 composer 下方的模板面板。
//
// 后三个是同一个模式的三面：点模板会把模板的描述写进输入框，用户改完直接回车。
// 状态按 sessionId 分片 —— 模式是会话的属性，不是全局开关。
//
// 于是「同一个小程序」有四个打开位置：会话页签、全屏浮层、右侧抽屉、会话右上角浮窗。
// 四者跑的是**同一个运行页组件**（RunnerView）—— 同一条沙箱串、同一个 `src=SERVE/…`，
// 只有露出来的动作按 `chrome` 分档；没有第二份 iframe 实现。
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
								// 原版从库页面跳到启动页的小程序模式；这里复制一段同样意图的文本。
								create: "创建小程序"
							},
							create: {
								prompt: "请帮我做一个小程序 —— 一个自包含的单文件网页小工具。\n\n我想要的是：（在这里描述你的想法，例如：一个带提醒的番茄钟 / 一个记账本 / 一个倒计时）\n\n要求：界面现代美观、打开即用、不需要任何构建步骤。做完之后提醒我去「小程序」面板点「发布」。",
								copied: "创建提示词已复制，粘贴到任意会话即可开始"
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
							// 「换个地方打开」：运行页工具栏上那三枚按钮，以及它们的降级文案。
							open: {
								location: {
									session: "在本会话页签打开",
									drawer: "在右侧打开",
									corner: "在会话右上角打开"
								},
								// 切页签要碰 DSH 的内部服务，拿不到时不能静默 —— 这句话就是"怎么办"。
								placed: "已放到本会话的「小程序」页签 —— 点会话头部的页签切过去。",
								noSession: "拿不到当前会话，没能放进页签。先在左侧选中一个会话再试。",
								missing: "这个小程序已经不在了。"
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
							create: {
								prompt: "Please build me a mini-app — a self-contained single-file web tool.\n\nWhat I want: (describe it here — e.g. a pomodoro timer with reminders / an expense tracker / a countdown)\n\nRequirements: a modern, good-looking UI; usable the moment it opens; no build step. When you are done, remind me to press Publish in the MiniApps panel.",
								copied: "Creation prompt copied — paste it into any session to start"
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
							// "Open somewhere else": the three toolbar buttons and their fallback copy.
							open: {
								location: {
									session: "Open in this session's tab",
									drawer: "Open on the right",
									corner: "Open in the corner"
								},
								placed: "Placed in this session's MiniApp tab — switch to it with the tab in the session header.",
								noSession: "Could not determine the current session, so it was not placed in a tab. Select a session in the sidebar and try again.",
								missing: "This mini-app is gone."
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
			/** 「在右侧打开」：一个窗口，右边那一列是实心的侧栏。 */
			side: "M3 4h18v2H3zM3 18h18v2H3zM3 4h2v16H3zM19 4h2v16h-2zM12 6h6v12h-6z",
			/** 「在会话右上角打开」：一个窗口，右上角还嵌着一个小窗口（画中画那层意思）。 */
			corner: "M3 4h18v2H3zM3 18h18v2H3zM3 4h2v16H3zM19 4h2v16h-2zM12 7h6v5h-6z"
		};

		/** 一个图标。`size` 对应原版传给 IconPark 的像素尺寸。 */
		function Icon(props) {
			return React.createElement("svg", {
				viewBox: "0 0 24 24",
				width: props.size,
				height: props.size,
				style: { display: "block", flex: "0 0 auto", fill: "currentColor" },
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

		function createUiState() {
			// settingsInjected：设置栏注入是否已经成功。注入成功时兜底座位的按钮让位。
			//
			// drawerId / cornerId 是那两个浮层**要跑哪个小程序** —— 它们是从运行页的
			// 工具栏上打开的（"保持浮层里的选择"），所以打开时就把 id 一起带上，
			// 而不是让浮层自己去猜"当前是哪一个"。
			//
			// toast 是**三个浮层都关着时也要能显示的一句话**：「已放到本会话页签」那条
			// 必须活在浮层关闭之后，否则用户根本看不到它。
			var state = {
				open: false,
				drawer: false,
				corner: false,
				drawerId: null,
				cornerId: null,
				runningId: null,
				toast: null,
				settingsInjected: false
			};
			var listeners = new Set();
			return {
				get: function () { return state; },
				set: function (patch) {
					var next = Object.assign({}, state, patch);
					// 互斥判决只写这一次：任何一处 `set({ drawer: true })` 都会顺手
					// 关掉另外两个，调用方不需要记得这件事。
					for (var index = 0; index < SURFACE_KEYS.length; index += 1) {
						var opened = SURFACE_KEYS[index];
						if (patch[opened] !== true) continue;
						for (var other = 0; other < SURFACE_KEYS.length; other += 1) {
							if (SURFACE_KEYS[other] !== opened) next[SURFACE_KEYS[other]] = false;
						}
					}
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
		// 库页面、会话页签、右侧抽屉、右上角浮窗都只需要同一份东西：「已发布的小程序」列表。
		// 目录放在模块级而不是各自的 useState 里，有两个具体理由：
		//
		//  1. 抽屉与浮窗是"打开即用"的：它们只有一次渲染机会，等不到"先渲染一次、effect
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

		/**
		 * 把一个小程序放进某个会话的页签，并把页签切过去。
		 *
		 * 顺序是有意的：**先写 store，再去切页签**。于是即使切页签那一步失败
		 * （页签不在），用户手动点一下上方页签，看到的也已经是他刚才选的那一个 ——
		 * 而不是一个空态。
		 *
		 * @returns 页签切过去了吗；false 只表示"没切过去"，选择本身已经生效。
		 */
		function openInSession(ctx, sessionId, appId, tabLabel) {
			if (typeof sessionId !== "string" || sessionId === "") return false;
			if (typeof appId !== "string" || appId === "") return false;
			sessionViewStore.open(sessionId, appId);
			return focusSessionViewTab(tabLabel);
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

		/** 卡片右上角的 26×26 图标动作。 */
		function CardAction(props) {
			var [hover, setHover] = useState(false);
			var danger = props.danger === true;
			return React.createElement("div", {
				role: "button", tabIndex: 0,
				title: props.label, "aria-label": props.label,
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
			}, React.createElement(Icon, { name: props.icon, size: 14 }));
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

		/** 32×32 工具栏图标动作。 */
		function ToolbarAction(props) {
			var [hover, setHover] = useState(false);
			var danger = props.danger === true;
			return React.createElement("div", {
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
			}, React.createElement(Icon, { name: props.icon, size: 16 }));
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
		 *    外加「换个地方打开」的三枚按钮；
		 *  * `"compact"` —— 会话页签：只留「刷新 / 在浏览器中打开 / 关闭」。这里是会话区，
		 *    不该出现那两枚带文字的大按钮（发布、继续迭代），它们会把会话的头压得很重；
		 *  * `"none"` —— 右侧抽屉与右上角浮窗：**不画工具栏**。它们自己有一行头
		 *    （名字 + 在浏览器中打开 + 关闭），再画一条就是两条头。
		 */
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
				window.open(SERVE + "/" + encodeURIComponent(app.miniapp_id), "_blank", "noopener");
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
						React.createElement(ToolbarAction, { icon: "browser", label: t("actions.openInBrowser"), onRun: openExternally }),
						// 「换个地方打开」的三枚。它们只在全屏浮层里出现 —— 会话页签与
						// 那两个浮层本身就是"别的地方"，再放一遍这三个按钮没有对象。
						// 每个 handler 都由浮层传进来（`undefined` 时不画），于是这个组件
						// 仍然不需要 ctx。
						props.onOpenInSession === undefined ? null : React.createElement(ToolbarAction, {
							icon: "tab", label: t("open.location.session"),
							onRun: function () { props.onOpenInSession(app); }
						}),
						props.onOpenInDrawer === undefined ? null : React.createElement(ToolbarAction, {
							icon: "side", label: t("open.location.drawer"),
							onRun: function () { props.onOpenInDrawer(app); }
						}),
						props.onOpenInCorner === undefined ? null : React.createElement(ToolbarAction, {
							icon: "corner", label: t("open.location.corner"),
							onRun: function () { props.onOpenInCorner(app); }
						}),
						compact ? null : React.createElement(ToolbarAction, { icon: "edit", label: t("actions.rename"), onRun: function () { props.onRename(app); } }),
						compact ? null : React.createElement(ToolbarAction, { icon: "trash", label: t("actions.delete"), danger: true, onRun: function () { props.onDelete(app); } }),
						React.createElement(ToolbarAction, { icon: "close", label: t("actions.close"), onRun: props.onClose })
					)
				) : null,

				// 一行说明用户改动现在处于哪一层 —— 或者还没到哪一层。
				app.has_unpublished_changes ? React.createElement("div", {
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
						src: SERVE + "/" + encodeURIComponent(app.miniapp_id),
						sandbox: IFRAME_SANDBOX,
						title: app.name,
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
		// 身体复用同一个 RunnerView（`chrome: "compact"`），所以"同一个小程序在四个地方
		// 跑"是同一个组件、同一条沙箱串、同一个 `src=SERVE/…`，没有第二份 iframe。

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
					onClose: function () { sessionViewStore.close(sessionId); }
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
				return ui.subscribe(function () {
					var next = ui.get();
					setOpen(next.open);
					if (next.runningId !== null) {
						var target = next.runningId;
						setApps(function (current) {
							var found = current.filter(function (app) { return app.miniapp_id === target; })[0];
							if (found) setRunning(found);
							return current;
						});
					}
				});
			}, [ui]);

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

			// 「创建」：原版是从启动页进入小程序模式。DSH 里没有那个入口，
			// 所以给出同一段意图的可粘贴文本 —— 与「继续迭代」同一种做法。
			var create = useCallback(async function () {
				await copyText(t("create.prompt"), t("create.copied"), "errors.actionFailed");
			}, [copyText, t]);

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
			 * 「在本会话页签打开」。
			 *
			 * 顺序与后果都是刻意的：
			 *  1. 当前会话 id 只能从 `sessions.list.getSnapshot().current` 取；取不到就
			 *     **就地**说清楚，浮层不关 —— 这时候关掉浮层等于把用户扔到一个什么都没
			 *     发生的地方。
			 *  2. `openInSession` 先把选择写进 store，再去切页签。所以无论切没切成功，
			 *     用户手动点上方页签看到的都是他刚选的那一个。
			 *  3. 浮层一律关掉：要么用户已经被切到页签了，要么提示会告诉他去哪里找。
			 *     提示挂在 `ui.toast` 上（不是浮层内部的 notice）—— 它必须活在浮层关闭之后。
			 */
			var placeInSession = useCallback(function (app) {
				var sessionId = currentSessionId(props.ctx);
				if (sessionId === null) {
					showNotice(t("open.noSession"));
					return;
				}
				var switched = openInSession(props.ctx, sessionId, app.miniapp_id, t("view.tab"));
				if (switched) {
					ui.set({ open: false });
					return;
				}
				ui.set({ open: false, toast: t("open.placed") });
			}, [props.ctx, showNotice, t, ui]);

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
							// 「换个地方打开」的两个浮层：把当前运行的这一个带过去，
							// 而不是让新浮层从头再选一次。
							onOpenInDrawer: function (app) {
								ui.set({ drawer: true, drawerId: app.miniapp_id });
							},
							onOpenInCorner: function (app) {
								ui.set({ corner: true, cornerId: app.miniapp_id });
							},
							onOpenInSession: placeInSession
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

		// -------------------------------------------------------- 两个贴边浮层
		//
		// 「在右侧打开」与「在会话右上角打开」是**两个不同的位置**：
		//  * 抽屉锚在**整个窗口**的右边，通高（top/bottom 贴边）；
		//  * 浮窗锚在**会话区**的右上角，是一块有界的窗口（约 380×420）。
		// 除了几何与锚点，两者完全一样 —— 同一行头、同一个身体、同一套互斥语义，
		// 所以是同一个组件加一个 `variant`。
		//
		// **为什么是浮层而不是布局列**：它们靠 `position: fixed` 浮在会话之上，
		// 不参与布局 —— 于是打开它不会把会话挤窄、不会让消息重排、也不会打断正在打的字。
		// 这这正是它存在的理由。DSH 里"右侧那一列"是 `details` 座位，但那个座位被
		// ui-conversation 的 DetailsPanel 占着、它自己还声明着工具详情座位 ——
		// 注册进去会把「工具详情」整个功能顶掉（`replaceRisk: "shadows-shipped-ui"`），
		// 所以这里**不碰** `details`，用自己的浮层画一个看起来像抽屉的东西。
		//
		// z 轴：三个浮层都低于全屏浮层（50）—— 全屏浮层是"要看完再回来"的模态，
		// 抽屉与浮窗是"边聊边用"的旁挂件；对话框（60/70）又要压在它们之上。

		/** 抽屉 / 浮窗的层级。低于全屏浮层的 50，高于会话内容。 */
		var FLOATING_Z_INDEX = 46;
		/** 右上角浮窗的尺寸上限与到会话区边缘的间距。 */
		var CORNER_WIDTH = 380;
		var CORNER_HEIGHT = 420;
		var CORNER_GAP = 12;
		/**
		 * 会话区右上角的坐标（`position: fixed` 用的 top / right）。
		 *
		 * 公式：`top = 会话区顶边 + 12`，`right = 窗口宽 − 会话区右边 + 12`
		 * —— 后者是"从窗口右边量到会话区右边"的那段距离。
		 *
		 * 三个必须照顾到的退化情况：
		 *  1. `scrollRect` 拿不到（没有会话、DOM 还没挂上、更老的 DSH）→ 退回窗口右上角
		 *     的 `12 / 12`，绝不画到屏幕外；
		 *  2. 视口尺寸拿不到（测试的 vm、极早期的一次渲染）→ 不做夹取，但仍然给出有限值，
		 *     绝不出现 `NaN`；
		 *  3. 会话区很小或窗口很窄时把它**夹回窗口内** —— 夹取用的是 CSS 里那条
		 *     `min(380px, 40vw)` / `min(420px, 55vh)` 的同一个算术，所以夹出来的一定
		 *     是它真实占的那块地方。
		 */
		function cornerWindowPosition(scrollRect, viewportWidth, viewportHeight) {
			var top = CORNER_GAP;
			var right = CORNER_GAP;
			if (scrollRect !== null && scrollRect !== undefined) {
				if (Number.isFinite(scrollRect.top)) top = scrollRect.top + CORNER_GAP;
				if (Number.isFinite(scrollRect.right) && Number.isFinite(viewportWidth)) {
					right = viewportWidth - scrollRect.right + CORNER_GAP;
				}
			}
			var width = Number.isFinite(viewportWidth) ? Math.min(CORNER_WIDTH, viewportWidth * 0.4) : CORNER_WIDTH;
			var height = Number.isFinite(viewportHeight) ? Math.min(CORNER_HEIGHT, viewportHeight * 0.55) : CORNER_HEIGHT;
			if (Number.isFinite(viewportHeight)) top = Math.min(top, viewportHeight - height - CORNER_GAP);
			if (Number.isFinite(viewportWidth)) right = Math.min(right, viewportWidth - width - CORNER_GAP);
			if (!Number.isFinite(top)) top = CORNER_GAP;
			if (!Number.isFinite(right)) right = CORNER_GAP;
			return {
				top: Math.round(Math.max(CORNER_GAP, top)),
				right: Math.round(Math.max(CORNER_GAP, right))
			};
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

		/** 读视口尺寸；读不到给 undefined（`cornerWindowPosition` 会跳过夹取）。 */
		function viewportSize() {
			if (typeof window === "undefined") return { width: undefined, height: undefined };
			return {
				width: Number.isFinite(window.innerWidth) ? window.innerWidth : undefined,
				height: Number.isFinite(window.innerHeight) ? window.innerHeight : undefined
			};
		}

		/** 抽屉 / 浮窗里那颗小程序不存在或还没到位时，身体上那一行小字。 */
		function floatingBodyNote(t, catalog) {
			if (catalog.error !== null) return t("errors.loadListFailed", { message: catalog.error });
			if (catalog.loaded !== true || catalog.loading === true) return t("list.loading");
			return t("open.missing");
		}

		function MiniAppFloatingRunner(props) {
			var t = props.t;
			var variant = props.variant === "corner" ? "corner" : "drawer";
			var appId = props.appId;
			var catalog = useCatalog();
			var app = findCatalogApp(catalog, appId);

			// 目录没被拉过就拉一次。这一步不能省：浮层是从运行页工具栏打开的、
			// 打开的那一刻会**把全屏浮层关掉**（三个浮层互斥），而全屏浮层那份列表
			// 是它自己的局部状态、跟着它一起消失 —— 浮层必须能自己把 appId 变成记录，
			// 否则用户看到的是一个永远停在"正在加载…"的空壳。
			useEffect(function () {
				if (catalog.loaded === true || catalog.loading === true) return;
				void appCatalog.load(false);
			}, [catalog.loaded, catalog.loading]);

			// 定位只对浮窗有意义；抽屉是通高的，直接贴窗口右边。
			//
			// 初值就是**量一次**的结果（而不是 12/12 再在 effect 里纠正）：这样首帧就
			// 落在正确的位置上，不会先闪一下窗口右上角再跳过去。effect 只负责跟随变化。
			var [position, setPosition] = useState(function () {
				if (variant !== "corner") return null;
				var size = viewportSize();
				return cornerWindowPosition(measureConversationRect(), size.width, size.height);
			});

			useEffect(function () {
				if (variant !== "corner") return undefined;
				var sync = function () {
					var size = viewportSize();
					var next = cornerWindowPosition(measureConversationRect(), size.width, size.height);
					setPosition(function (current) {
						// 位置没变就不写状态：这个 sync 会被 ResizeObserver 反复叫醒，
						// 每次写一个新对象会让 React 一直重渲染。
						if (current !== null && current.top === next.top && current.right === next.right) return current;
						return next;
					});
				};
				var node = null;
				try {
					node = typeof document !== "undefined" && typeof document.querySelector === "function"
						? document.querySelector("[data-conversation-scroll]")
						: null;
				} catch (error) {
					node = null;
				}
				var observer = typeof ResizeObserver === "function" && node !== null && node !== undefined
					? new ResizeObserver(sync)
					: null;
				if (observer !== null) observer.observe(node);
				if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
					window.addEventListener("resize", sync);
				}
				return function () {
					if (observer !== null) observer.disconnect();
					if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
						window.removeEventListener("resize", sync);
					}
				};
			}, [variant]);

			var geometry = variant === "corner"
				? {
					// 锚会话区右上角：坐标是量出来的（见 cornerWindowPosition），
					// position: fixed 让它**不参与布局**。
					position: "fixed",
					top: position === null ? CORNER_GAP : position.top,
					right: position === null ? CORNER_GAP : position.right,
					width: "min(380px, 40vw)",
					height: "min(420px, 55vh)",
					borderRadius: 12,
					border: "1px solid " + T.border1,
					boxShadow: "0 18px 48px rgba(0,0,0,0.24)"
				}
				: {
					// 锚整个窗口的右边、通高。同样是 fixed —— 它是浮层，不是布局列，
					// 打开它不会把会话挤窄（那正是它和"真正的右侧栏"的区别）。
					position: "fixed",
					top: 0,
					right: 0,
					bottom: 0,
					width: "min(420px, 42vw)",
					borderLeft: "1px solid " + T.border1,
					boxShadow: "0 18px 48px rgba(0,0,0,0.24)"
				};

			var marker = variant === "corner" ? { "data-dsh-miniapp-corner": "" } : { "data-dsh-miniapp-drawer": "" };

			return React.createElement("div", Object.assign({
				role: "complementary",
				"aria-label": app !== null ? app.name : t("title"),
				style: Object.assign({
					zIndex: FLOATING_Z_INDEX, display: "flex", flexDirection: "column",
					minHeight: 0, boxSizing: "border-box",
					background: T.bgLayer1, overflow: "hidden"
				}, geometry)
			}, marker),
				// 头部一行：名字 + 在浏览器中打开 + 关闭。浮层的头是**它的窗框**，
				// 所以身体里的 RunnerView 用 chrome: "none"（不再画第二条工具栏）。
				React.createElement("div", {
					style: {
						flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8,
						height: 44, padding: "0 8px 0 12px", boxSizing: "border-box",
						borderBottom: "1px solid " + T.border1
					}
				},
					React.createElement("span", {
						"aria-hidden": "true",
						style: {
							display: "grid", placeItems: "center", width: 24, height: 24,
							flex: "0 0 auto", borderRadius: 8,
							fontSize: 14, lineHeight: 1, color: T.brand, background: tint(T.brand, 12)
						}
					}, app !== null && (app.icon || "").trim() !== "" ? app.icon : React.createElement(Icon, { name: "app", size: 14 })),
					React.createElement("span", {
						style: {
							flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
							whiteSpace: "nowrap", fontSize: 13, fontWeight: 600, color: T.text1
						}
					}, app !== null ? app.name : t("title")),
					app !== null ? React.createElement(ToolbarAction, {
						icon: "browser", label: t("actions.openInBrowser"),
						onRun: function () {
							window.open(SERVE + "/" + encodeURIComponent(app.miniapp_id), "_blank", "noopener");
						}
					}) : null,
					React.createElement(ToolbarAction, {
						icon: "close", label: t("actions.close"), onRun: props.onClose
					})
				),
				app !== null
					? React.createElement(RunnerView, {
						t: t, app: app, chrome: "none",
						onRefresh: function () { void appCatalog.load(true); },
						onPublished: function () { void appCatalog.load(true); },
						onClose: props.onClose
					})
					: React.createElement("div", {
						role: "status",
						style: Object.assign({}, TEXT3, {
							padding: "24px 14px", fontSize: 12, lineHeight: "18px", textAlign: "center"
						})
					}, floatingBodyNote(t, catalog))
			);
		}

		/**
		 * `shell.overlay` 座位上**唯一**的那个组件：三个浮层互斥，这里只画当前那一个。
		 *
		 * 为什么不各注册一个座位：`shell.overlay` 上多注册一格当然也能画，但那样
		 * "互斥"就得靠三个组件互相通知；现在它们读的是同一份 `ui`，互斥是状态层的
		 * 一条判决（见 createUiState），渲染层只需要照它画。
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

			var surface = null;
			if (state.corner === true && state.cornerId !== null) {
				surface = React.createElement(MiniAppFloatingRunner, {
					t: props.t, variant: "corner", appId: state.cornerId,
					onClose: function () { ui.set({ corner: false }); }
				});
			} else if (state.drawer === true && state.drawerId !== null) {
				surface = React.createElement(MiniAppFloatingRunner, {
					t: props.t, variant: "drawer", appId: state.drawerId,
					onClose: function () { ui.set({ drawer: false }); }
				});
			} else {
				// 全屏浮层自己判 `open`：没打开时它返回 null。
				surface = React.createElement(MiniAppOverlay, props);
			}

			return React.createElement(React.Fragment, null,
				surface,
				state.toast === null ? null : React.createElement("div", {
					role: "status",
					style: {
						position: "fixed", left: "50%", bottom: 28, transform: "translateX(-50%)",
						zIndex: FLOATING_Z_INDEX + 1, maxWidth: "min(560px, 88vw)",
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

		/** 三个 composer 座位的名字，与 DSH 的 contract 逐字一致。 */
		var COMPOSER_SLOTS = {
			hero: "conversation.hero.modeActions",
			accessory: "conversation.input.accessory",
			dock: "conversation.composer.dock"
		};
		/** 三处座位共用同一个 id：list 槽位里用自己独有的格子，而不是替换别人的。 */
		var COMPOSER_ID = "dsh-miniapp";
		/** 排序：PPT 占 20，queue / todo / goal 占 0 / 10 / 20；45 落在它们之后。 */
		var COMPOSER_ORDER = 45;
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
		// 一个字节都不会沾上它。

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

		/** 面板：只有在会话还是空白时才铺开。 */
		function MiniAppStandardComposerDock(props) {
			if (!props.session.blank) return null;
			return React.createElement(MiniAppTemplatePanel, props);
		}

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

		/** 输入框旁的模式 chip：与 hero 的那个同一个语义，但只服务空白会话。 */
		function MiniAppStandardInputAccessory(props) {
			if (!props.session.blank) return null;
			return React.createElement(MiniAppInputAccessory, props);
		}

		/** hero 上的模式 chip。hero 只在空白会话里存在，所以这里不需要再判一次。 */
		function MiniAppStandardModeAction(props) {
			var state = useMode(props.mode, props.sessionId);
			if (props.session === undefined || props.session === null || props.sessionId === undefined) return null;
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
		//     div[data-dsh-sidebar-settings]          ← slot "sidebar.settings" { wide }
		// 而 `sidebar.settings` 是 kind:"single"，只有一个占位者（settings-general），
		// 所以**不能**再往那个槽位注册第二行。DSH Desktop 自己的「连接移动设备」按钮
		// 走的是同一条路：往 [data-dsh-sidebar-settings] 里 appendChild 一个 button，
		// 用绝对定位挤进那一行。这里照做 —— 并用同样的几何躲开它的 38px 槽位。

		/** 侧栏图标：描边风格（与 DSH Desktop 的手机按钮同一套画法），19×19。 */
		var SIDEBAR_ICON_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">'
			+ '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke="currentColor" stroke-width="1.7"/>'
			+ '<path d="M3.5 8.9h17" stroke="currentColor" stroke-width="1.7"/>'
			+ '<path d="M12 12.2v5M9.5 14.7h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'
			+ '</svg>';

		/**
		 * 侧栏按钮的样式表。
		 *
		 * 两个不显然但必须的地方：
		 *
		 * 1. `[data-dsh-sidebar-settings]` 写了两遍。DSH Desktop 的 preload 也写了
		 *    一条 `[data-dsh-sidebar-root][data-dsh-sidebar-wide="true"]
		 *    [data-dsh-sidebar-settings]`，特异度是 (0,3,0)；我们**不保证**自己的
		 *    `<style>` 排在它后面，所以把类名重复一遍把特异度顶到 (0,4,0)，
		 *    由特异度而不是文档顺序来决定谁赢。
		 * 2. 手机按钮占着 `right:0` 的 38px，我们的按钮放在它左边（`right:38px`），
		 *    于是那一行要给两个按钮留 76px。页面上没有手机按钮时（:has 兜底）
		 *    退回一条按钮的位置。
		 */
		var SIDEBAR_CSS = [
			"#dsh-miniapp-sidebar-button { appearance:none; position:relative; width:32px; height:32px; color:var(--dsw-alias-label-secondary,#73777f); background:transparent; border:0; border-radius:9px; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; padding:0; }",
			'[data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] [data-dsh-sidebar-settings][data-dsh-sidebar-settings] { position:relative; box-sizing:border-box; padding-right:76px; }',
			'[data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] [data-dsh-sidebar-settings][data-dsh-sidebar-settings]:not(:has(#dsh-desktop-mobile-button)) { padding-right:38px; }',
			'[data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] #dsh-miniapp-sidebar-button { position:absolute; right:38px; top:50%; transform:translateY(-50%); }',
			'[data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] [data-dsh-sidebar-settings]:not(:has(#dsh-desktop-mobile-button)) #dsh-miniapp-sidebar-button { right:0; }',
			'[data-dsh-sidebar-root][data-dsh-sidebar-wide="false"] [data-dsh-sidebar-settings][data-dsh-sidebar-settings] { flex-direction:column; align-items:center; padding-right:0; }',
			'[data-dsh-sidebar-root][data-dsh-sidebar-wide="false"] #dsh-miniapp-sidebar-button { position:static; flex:none; margin-top:5px; transform:none; }',
			"#dsh-miniapp-sidebar-button:hover { color:var(--dsw-alias-label-primary,#202124); background:var(--dsw-alias-interactive-bg-hover,rgba(32,33,36,.08)); }",
			"#dsh-miniapp-sidebar-button:focus-visible { outline:2px solid #4d6bfe; outline-offset:1px; }"
		].join("\n");

		/** `<style>` 标签的身份，用来去重；清理时按 data-plugin 认领自己的那一份。 */
		var SIDEBAR_STYLE_ID = "dsh-miniapp/sidebar.css";
		var SIDEBAR_BUTTON_ID = "dsh-miniapp-sidebar-button";
		/** MutationObserver 的合并窗口：React 重建子树的中间态不该让我们反复重建按钮。 */
		var SIDEBAR_SETTLE_MS = 60;

		/**
		 * 把「小程序」按钮挂进设置栏那一行。
		 *
		 * 为什么不是注册一个槽位：`sidebar.settings` 是 single，注册第二行会**替换**掉
		 * 设置按钮本身。所以这里走 DOM 注入 —— 与 DSH Desktop 自己的「连接移动设备」
		 * 完全同一条路。
		 *
		 * 侧栏折叠 / 展开、设置面板开合都会让 React 重建那棵子树，按钮会被连带移除，
		 * 所以在 body 上挂一个 debounce 过的 MutationObserver 自愈。
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
			var timer = null;
			var button = null;

			var ensure = function () {
				var area = document.querySelector("[data-dsh-sidebar-settings]");
				if (area === null) {
					// 侧栏整块还没挂上（或正在重建）：把按钮摘掉，等下一次 ensure 再来。
					if (button !== null && button.parentElement !== null) button.parentElement.removeChild(button);
					button = null;
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
				if (button.parentElement !== area) area.appendChild(button);
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

			return function () {
				if (observer !== null) observer.disconnect();
				observer = null;
				if (timer !== null) window.clearTimeout(timer);
				timer = null;
				if (button !== null && button.parentElement !== null) button.parentElement.removeChild(button);
				button = null;
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
				var ui = createUiState();

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

				ctx.slots.inject(COMPOSER_SLOTS.hero, function () {
					return ctx.slots.register({
						name: COMPOSER_SLOTS.hero,
						id: COMPOSER_ID,
						order: COMPOSER_ORDER,
						locale: NS,
						inject: composerInject
					}, MiniAppStandardModeAction);
				});

				ctx.slots.inject(COMPOSER_SLOTS.accessory, function () {
					return ctx.slots.register({
						name: COMPOSER_SLOTS.accessory,
						id: COMPOSER_ID,
						order: COMPOSER_ORDER,
						locale: NS,
						inject: composerInject
					}, MiniAppStandardInputAccessory);
				});

				ctx.slots.inject(COMPOSER_SLOTS.dock, function () {
					return ctx.slots.register({
						name: COMPOSER_SLOTS.dock,
						id: COMPOSER_ID,
						order: COMPOSER_ORDER,
						locale: NS,
						inject: composerInject
					}, MiniAppStandardComposerDock);
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
						// ctx 也要交出去：运行页工具栏上那枚「在本会话页签打开」需要它
						// 去取当前会话 id、并调用 uiConversation（见 placeInSession）。
						inject: function () { return { ui: ui, ctx: ctx }; }
					}, MiniAppOverlaySeat);
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
				ctx.slots.inject(VIEW_SLOT, function () {
					return ctx.slots.register({
						name: VIEW_SLOT,
						id: VIEW_ID,
						order: VIEW_ORDER,
						locale: NS,
						label: function () { return t("view.tab"); },
						inject: function () { return { ctx: ctx }; }
					}, MiniAppSessionView);
				});
			} catch (error) {
				console.error("[dsh-miniapp] client half failed to load (host half unaffected):", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		// 以下导出只为让测试能直接契约到模式状态机与那两个"只在空白会话出现"的判决，
		// DSH 自己只会用 apply / inject / name。
		exports.COMPOSER_SLOTS = COMPOSER_SLOTS;
		exports.COMPOSER_ID = COMPOSER_ID;
		exports.COMPOSER_ORDER = COMPOSER_ORDER;
		exports.MiniAppModeStore = MiniAppModeStore;
		exports.MiniAppStandardModeAction = MiniAppStandardModeAction;
		exports.MiniAppStandardInputAccessory = MiniAppStandardInputAccessory;
		exports.MiniAppStandardComposerDock = MiniAppStandardComposerDock;
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
		exports.findSessionViewTab = findSessionViewTab;
		// 目录（三处运行面共用一份列表）也露出来：测试要能把它的快照种进去。
		exports.MiniAppCatalog = MiniAppCatalog;
		exports.appCatalog = appCatalog;
		// 两个贴边浮层：互斥的渲染口、几何常量与定位函数。
		exports.MiniAppFloatingRunner = MiniAppFloatingRunner;
		exports.MiniAppOverlaySeat = MiniAppOverlaySeat;
		exports.cornerWindowPosition = cornerWindowPosition;
		exports.CORNER_WIDTH = CORNER_WIDTH;
		exports.CORNER_HEIGHT = CORNER_HEIGHT;
		exports.CORNER_GAP = CORNER_GAP;
		exports.FLOATING_Z_INDEX = FLOATING_Z_INDEX;
		exports.RunnerView = RunnerView;
		return module.exports;
	}
});
