// dsh-miniapp — host half.
//
// Ports NomiFun Desktop's 小程序 feature to DeepSeek Harness. The product loop
// is the same one the original settled on after two rewrites:
//
//   create  → an agent writes ONE self-contained HTML file into the app's own
//             workspace, which is a stable path outside any session workspace;
//   iterate → the app outlives every session that edits it: a new, ordinary
//             session is simply TOLD the absolute source path;
//   publish → an explicit act that promotes the working copy to the served
//             snapshot, so "the AI changed it" and "the app changed" stay two
//             separate events;
//   reuse   → the library and the runner serve the published snapshot forever.
//
// Nothing here redirects a session's workspace, and nothing here creates or
// deletes a conversation. The store does not know what a session is; the only
// link is provenance.

import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
	MiniAppBadRequest,
	MiniAppNotFound,
	MiniAppStore,
	HTML_MAX_BYTES,
	isMiniAppId
} from './store.js'
import {
	applyFixes,
	clampName,
	validateImport,
	suggestName
} from './validate.js'
import { TEMPLATE_SUMMARIES, findTemplate } from './templates.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-miniapp'
/**
 * Tools are the whole model-facing surface; the store is ours alone.
 *
 * `skills` is a HARD dependency, not an optional one read through
 * `ctx.inject([...])`, because the skill IS the feature here: a half-registered
 * plugin (tools present, `/create-miniapp` missing) is exactly the confusing
 * state this feature exists to remove. The cost is real and worth stating:
 * on a DSH that has no `skills` service the whole host half waits instead of
 * activating. Measured on the install this plugin targets: `skills` is
 * provided by `@deepseek-ai/dsh-skill`, which rides the `@deepseek-ai/dsh-base`
 * bundle every profile loads, so there is no such deployment there.
 */
export const inject = ['tools', 'skills']

/**
 * URL spaces this bundle owns.
 *
 * Two explicit prefixes rather than one `/plugins/dsh-miniapp`, out of
 * hygiene rather than necessity: `/plugins/<package>/…` is a namespace the
 * host already speaks for, and a plugin that claims all of it leaves no room
 * for any path DSH may define there later. `/api` and `/serve` also state
 * exactly what they carry.
 *
 * Worth recording what was MEASURED here, so the reasoning does not decay into
 * folklore: a client bundle is served from the combo URL
 * `/plugins/??<package>/client.js&rev=…`, whose pathname is `/plugins/` — the
 * `<package>/client.js` part is the query string. So a wider prefix would not
 * actually have swallowed it, and an earlier comment in this file claiming it
 * would was wrong. The narrow split stayed because it is the better shape.
 */
export const API_PREFIX = '/plugins/dsh-miniapp/api'
/** The capability-URL document channel the runner iframe loads. */
export const SERVE_PREFIX = '/plugins/dsh-miniapp/serve'

/**
 * The iframe grant list, shared by every surface that runs a mini-app.
 *
 * Deliberately WITHOUT `allow-same-origin`. A mini-app document is generated
 * code: with `allow-scripts` AND `allow-same-origin` together the sandbox is
 * void, and the frame would reach the harness origin, its session cookie and
 * its storage. The cost is that storage APIs may throw inside the frame — which
 * is why the builder contract below tells every app to wrap them in try/catch.
 */
export const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals'

/**
 * The query the runner frame appends to opt into the height-reporting script.
 *
 * `?embed=1` is the ONLY difference between the two ways this channel is read,
 * and it is deliberately opt-in:
 *
 *  * without it the body is the published snapshot **byte for byte** — "what you
 *    see running is the document you published" is the whole point of this
 *    channel, and silently rewriting every response would end that;
 *  * with it the body gains one small `<script>` that only measures height and
 *    posts it to the parent. The float window needs it because the sandbox has
 *    no `allow-same-origin`: the parent cannot read the frame's document, so the
 *    document itself has to speak up.
 *
 * The client half (lib/client.js) must spell the same string; test/client.test.mjs
 * pins the two together, because a drift here fails SILENTLY — the message never
 * arrives and the window simply keeps its fallback height.
 */
export const EMBED_QUERY = 'embed=1'

/** The value `?embed=` must carry to mean "yes". Only `1`, never a truthy string. */
export const EMBED_VALUE = '1'

/**
 * The postMessage protocol type the injected script uses.
 *
 * Differs from the template-preview protocol on purpose: `message` events are
 * page-wide, and two protocols sharing one type name would claim each other's
 * messages (a 480px-wide preview's height applied to the runner window, or the
 * other way round).
 */
export const RUNNER_HEIGHT_MESSAGE_TYPE = 'dsh-miniapp:runner-height'

/** Grace period before the runner admits a frame may be stuck, in ms. */
export const LOAD_WATCHDOG_MS = 6000

/** Default data directory: `{DSH_HOME}/miniapp`. */
const DEFAULT_DATA_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'miniapp')

/**
 * Configuration surface — and **only** what the host half actually reads**.
 *
 * `showSidebarEntry` and `watchdogMs` used to be declared here and read nowhere
 * (the client half has no channel to host config, and its watchdog is its own
 * constant). A knob that silently does nothing is worse than no knob: the docs
 * promised `watchdogMs: 10000` would take effect and it never could. They are
 * gone until there is a real path from cordis.yml to the client half.
 */
export const Config = Schema.object({
	dataDir: Schema.string().default(DEFAULT_DATA_DIR).description('小程序数据目录（索引 + 每个小程序的快照与工作副本）')
})

/**
 * The contract handed to an agent that is about to build a mini-app.
 *
 * This is the port of the original's `MINI_APP_BUILDER_SYSTEM_PROMPT`. It rides
 * the tool result rather than a global prompt section on purpose: a system
 * prompt would apply to every session in the deployment, while this text is
 * only ever seen by a session that actually asked to build a mini-app — and the
 * tool call and its result are recorded, so nothing model-visible goes
 * unlogged.
 */
export const BUILDER_CONTRACT = `你正在为用户构建一个「小程序」—— 独立、自包含的网页小工具。规则：
1. 产物永远是这个小程序自己的一个文件。写它请用 miniapp_write_source（读用 miniapp_read_source）；不要写到会话工作区里。
   注意：小程序源码在会话工作区之外，默认的 workspace-write 文件沙箱不允许直接用 write/edit 工具改它，这不是错误，用上面两个工具即可。
2. 它必须完全自包含：内联全部 CSS 与 JavaScript；需要第三方库时走 CDN；不得依赖任何其他本地文件。
3. 界面追求现代、美观、可即时上手；不需要任何构建步骤（不要用 TypeScript、npm 或框架源码入口）。
4. 需要持久化数据时优先用 localStorage，键名加应用专属前缀；但运行环境是沙箱且来源不透明，存储 API 可能直接抛错 —— 所有读写必须包在 try/catch 里并优雅降级，核心功能不得依赖持久化。
5. 每一轮回复结束时它都必须是完整可运行的版本：首轮就给出可用版本，之后按用户反馈迭代。
6. 改完不会自动生效：用户要在「小程序」面板里点「发布」才会让它上线。收尾时告诉用户这一点。
7. 回复里简述改动即可，不要粘贴大段代码。`

/**
 * 技能的骨架名。
 *
 * **逐字等于** `/create-miniapp` 里的那个词，不是"差不多的名字"：DSH 输入框的
 * `/` 触发器把草稿里的 `/name` 拿去查当前会话的技能 lexicon，查不到就只是普通
 * 文本 —— 名字里少一个连字符，整条直达链路就退化成一个不认识的斜杠命令。
 * 名字必须匹配 DSH 的技能名规则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（见 asar 内
 * `@deepseek-ai/dsh-skill/lib/index.js` 的 `SKILL_NAME` 与 `validateRuntimeSkill`），
 * 所以中文名、驼峰名都不可行。
 */
export const CREATE_MINIAPP_SKILL_NAME = 'create-miniapp'

/**
 * 客户端预置进输入框的草稿。
 *
 * 尾部那个空格是**有意**的，而且由另一条规则保证它不会把装饰弄坏：
 * DSH 判定 `/name` 是否成词用的边界是 `/^(?:\s|$)/`（空白或草稿结尾），
 * 所以带不带尾随空格都合法；带上它是为了让光标落在名字之后，用户接着打字
 * 就是"这句话的补充"，而不是把标签接在词尾变成别的词。
 */
export const CREATE_MINIAPP_DRAFT = '/create-miniapp '

/**
 * `/create-miniapp` 这条嵌入式技能的正文。
 *
 * 它为什么是**嵌入式**（`ctx.skills.register`）而不是随包发一个 SKILL.md：
 * 这个插件是 `link:` 装进 profile 的，磁盘技能要落在用户级的 skills 目录里，
 * 与"插件自带的入口"对不上号；运行时注册挂在调用方 context 的层上，插件一卸载
 * 就随之消失，正是这里要的生命周期。
 *
 * 为什么 `modelInvocable: false`：这条技能的入口是**人**（用户在输入框里打
 * `/create-miniapp`，客户端替他把这句话预置好），而模型那一边已经有
 * `miniapp_create` 这件工具、以及它结果里那份完整的 `BUILDER_CONTRACT`。
 * 再让模型能自己"调用技能"，就是同一件事两套说法。
 *
 * 正文里**不出现**本机绝对路径、用户名、时间戳：技能正文是逐字进模型上下文的东西，
 * 同一份文本要在任何一台机器上都成立。
 *
 * `source` 是**必须自己写**的，别指望注册表补：`dsh-skill` 的 `register()`
 * 只补 `invocation` 与 `provider` 两个字段（它是 `{...skill, invocation, provider}`），
 * 而 `validateDefinition` 要求 `source` 是 string —— 少了它，注册**照样成功**、
 * `skills.list()` 里**照样看得见**（目录条目只是 `toSummary` 拷一遍字段，不校验），
 * 但 `skills.get(name)` 会抛 `loaded skill "…" source must be a string`。
 * 这条通道正是"用户敲 `/create-miniapp` 之后把技能正文注入模型上下文"走的那条
 * （`dsh-tool-skill` 的 pre-step 里 `await ctx.skills.get(name, lookup)`），
 * 而抛出的异常会被 `dsh-agent-loop` 那个裸 `catch (_error) {}` 吞掉 ——
 * 用户侧的表现因此是"发送之后什么都没发生"，而不是一条看得见的报错。
 * 一个字段的缺失，症状离病因隔了三条链路：这是本仓库最贵的一次"测试全绿"。
 *
 * 取值是**描述性来源标签**，不是闭集：`dsh-skill-filesystem` 用的是
 * `"project-dsh"` / `"user-agents"` / `"bundled"` 这一类字符串；注册表只把它
 * 拼进一条日志、并原样放进目录摘要，**不参与排序或去重**（排序看的是层与 provider）。
 * 所以这里写插件自己的名字，回答"这条技能从哪来的"。
 */
export const CREATE_MINIAPP_SKILL = Object.freeze({
	name: CREATE_MINIAPP_SKILL_NAME,
	description: '为用户创建一个小程序（自包含单文件网页小工具）：先用 miniapp_create 建行，再用 miniapp_write_source 写完整 HTML，最后提醒用户去「小程序」面板点发布。',
	whenToUse: '用户想做一个网页小工具或小程序时（番茄钟、待办、计算器、记账本、倒计时、随机选择器…），或直接说「做一个小程序 / 帮我做个小工具」。',
	source: 'dsh-miniapp',
	invocation: Object.freeze({ modelInvocable: false, userInvocable: true }),
	content: `# 创建小程序

你要为用户做一个小程序：一个**自包含的单文件网页小工具**。用户在「小程序」面板里点一次「发布」，它就随开随用。

## 三步，顺序不能变

1. **先建行**：调 miniapp_create（name 必填；description、icon 可选，icon 用一个 emoji）。
   名字短、像用户自己会起的（「番茄钟」「记账本」），不要「XX 工具 v2」。工具结果里带着完整的构建契约，照着它做。
2. **再写源码**：调 miniapp_write_source(miniapp_id, html)，写**完整的一份** —— 它是整份替换，不是增量编辑。
   - 要回看用 miniapp_read_source。**不要**用 read / write / edit 去动那个路径：源码在会话工作区之外，默认的 workspace-write 文件沙箱会拒绝它（这是设计，不是错误）。
   - 第一轮就要交出能直接跑的完整版本，不要骨架、不要 TODO。
3. **最后提醒发布**：写完不会自动生效。收尾时明确说：「去『小程序』面板点『发布』，改动才会生效。」
   - miniapp_publish 只在用户**明确要求**发布时用；默认由用户自己在面板上点。

## 这个文件必须满足（运行时事实，不是风格偏好）

1. 一个 HTML 文档：<!DOCTYPE html> 加 <html> / <body> 外壳，CSS 与 JavaScript 全部内联。
2. 不引用任何本地文件：相对的 src / href 是致命项；小图转成 data URI。
3. 需要第三方库就走 CDN 的完整地址；裸包名 import 浏览器解析不了（除非配 importmap）。
4. 没有构建步骤：不要 TypeScript、JSX、npm 依赖或 src/main.ts 这类源码入口，也不要服务端模板语法。
5. 运行环境是沙箱 iframe 且来源不透明：cookie、同源请求、service worker 都拿不到；localStorage / sessionStorage / indexedDB 可能直接抛错。所有存储读写都包在 try/catch 里并优雅降级，**核心功能不得依赖持久化**（键名加应用专属前缀）。
6. 整个文档不超过 4 MiB。
7. 界面现代、美观、点开就能用；窄窗口与手机要好用（meta viewport、点击目标别太小）。
8. 回复里简述做了什么即可，不要粘贴大段代码。

## 用户已经有页面时

- miniapp_validate(path)：只检查、不写盘，返回结构化问题清单 —— 用来回答「我这个页面能不能托管成小程序」。
- miniapp_import(path, name?, description?, icon?)：把一个自包含的 HTML 文件直接收进库；有致命项时拒绝并列出规则 id。
- 会被自动处理的：缺少 html / body 外壳的片段会补成完整文档。
- 只是提醒的：引用了外部 CDN、用到了浏览器存储、内部又嵌了 iframe。

## 继续改一个已有小程序

miniapp_iterate(miniapp_id) 物化工作副本 → 先用 miniapp_read_source 完整读一遍，不要凭猜改 → 用 miniapp_write_source 写回完整一份 → 提醒用户去「小程序」面板点发布。只动这一个文件。

## 别做的事

- 不要为「做个小程序」去建多文件工程、写构建配置、装依赖。
- 不要在会话工作区里留一份同名 miniapp.html 当产物 —— 小程序的源码归它自己的工作副本管。
- 不要替用户按发布，除非用户明确让你发布。
- 不要顺手改用户的原始项目：来源只读。`
})

function json(res, status, body) {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff'
	})
	res.end(text)
}

/**
 * 用**文档**回答，而不是用数据回答。
 *
 * 这条通道的消费者是**浏览器的文档视图**（iframe 里的预览，或者直接导航过去），
 * 它表达"缺口"的唯一手段就是响应体本身。于是"数据形状的错误"会被当成文档渲染出来：
 * `application/json` 即使带 `nosniff` 也会被浏览器**内联渲染成纯文本** —— 实测未发布的
 * id 拿到的是 `content-type: application/json; charset=utf-8` + `{"ok":false,…}`，
 * 用户在预览区看到的就是那段花括号。所以缺口要用文档说。
 *
 * 状态码仍然是 404（**绝不是** 401/403，理由见下面那条注释）；这里的形状与既有那条
 * "干净的 404"测试完全兼容（它只断言状态码）。`no-store` / `nosniff` 与 `json()` 保持一致。
 *
 * **名字刻意不叫 `html`**：serve 处理函数里有个局部变量就叫 `html`（`readSnapshot()` 的返回值），
 * 叫 `html` 会被它遮蔽 —— 真踩过一次，症状是调用处对着一个字符串调用、被外层 catch 兜成 500
 * （两条既有测试立刻变红：`500 !== 404`）。名字上避让比"记得别重名"可靠。
 */
function sendHtml(res, status, body) {
	res.writeHead(status, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff'
	})
	res.end(body)
}

/**
 * 「还没有发布过」的占位文档：自包含、零外链（沙箱与离线都成立）、不含任何数据形状。
 *
 * 它什么时候会被看到 —— **不是**"缓存说没发布"的那一刻。客户端（见 lib/client.js 的
 * `RunnerView`，搜 `hostConfirmedNeverPublished`）在 `published_at === null` 时**先照常挂
 * iframe**（fail-open），同时向宿主确认一次；**只有宿主也确认"从未发布"**，它才切到
 * `MiniAppNotPublished` 那个空态 —— 那时用户看到的是空态，不是这份文档。
 * 所以这份文档真正要接住的，是另外三种情形：① **直接导航**到 `/serve/{id}`（或者别的宿主
 * 自己嵌了这个 URL）；② 客户端**求证不了**（离线 / 老宿主 / 记录已删）时那次 fail-open ——
 * 宁可显示这句人话，也不把内容藏起来；③ 从"已确认从未发布"到切成空态之间的那一帧。
 * 无论谁看到它，看到的都该是一句人话。
 */
function notPublishedDocument() {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>还没有发布</title>
</head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#202124;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<main style="max-width:360px;padding:24px;text-align:center">
<h1 style="margin:0 0 8px;font-size:16px;font-weight:600">这个小程序还没有发布</h1>
<p style="margin:0;color:#5f6368">预览里暂时没有可运行的内容。在「小程序」面板里点一次「发布」，它就会出现在这里。</p>
</main>
</body>
</html>`
}

/** The loopback hosts the Local Web UI is served from. */
function isLoopbackHost(host) {
	if (typeof host !== 'string' || host.length === 0) return false
	const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
	return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare === '[::1]'
}

/**
 * Whether a request may mutate the library.
 *
 * A browser always attaches `Origin` to a cross-origin state-changing request,
 * so requiring a present, loopback `Origin` is what keeps a page the user
 * happens to be visiting from driving this API. Absent `Origin` is refused here
 * — unlike the serve channel below, no legitimate mutation arrives without one.
 */
function isTrustedMutation(req) {
	const origin = req.headers.origin
	if (typeof origin !== 'string') return false
	// `Sec-Fetch-Site` 是浏览器的**自述**：只比 host 是不够的 —— `http://localhost:9999`
	// 上任何一个本地页面（dev server、Jupyter、别的插件的 UI）都是"环回 Origin"，
	// 却完全不该能 create/publish/delete 这个小程序库。代理实测过这五种来源都能通过。
	//
	// 用 `same-origin` 而不是 `same-site`：按 Fetch 元数据的定义，**端口不参与**站点判定，
	// 所以 `localhost:9999` 对 `localhost:53319` 是 same-site 而**不是** same-origin ——
	// 那正是要挡住的那一类。DSH 自己的 `LanMobileBridge.verifyTrustedOrigin` 也是这么做的。
	//
	// 只在头部**存在**时才判：没有这个头的客户端（老浏览器、curl、脚本）仍然走下面的
	// Origin 检查，不会被这条改动意外打断。
	const site = req.headers['sec-fetch-site']
	if (typeof site === 'string' && site !== 'same-origin') return false
	try {
		return isLoopbackHost(new URL(origin).host)
	} catch {
		return false
	}
}

/**
 * Whether a request may read the library.
 *
 * Read-only, but still scoped to the Local Web UI: same-origin page fetches
 * carry a loopback `Origin`, and a plain navigation carries none but is
 * harmless.
 */
function isTrustedRead(req) {
	const origin = req.headers.origin
	if (typeof origin !== 'string') return true
	try {
		return isLoopbackHost(new URL(origin).host)
	} catch {
		return false
	}
}

/** Read and parse a JSON request body, capped so a stray upload cannot exhaust memory. */
async function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limitBytes) {
			// **必须把剩下的读掉（或销毁连接）。** 直接抛会让响应在"请求体还没读完"时
			// 结束，客户端复用的那条 keep-alive 连接上，**下一个**无关请求会拿到
			// ECONNRESET —— 生产环境里极难定位的间歇故障（代理实测复现过）。
			req.destroy()
			throw new MiniAppBadRequest('请求体过大')
		}
		chunks.push(chunk)
	}
	if (chunks.length === 0) return {}
	const text = Buffer.concat(chunks).toString('utf8')
	if (text.trim().length === 0) return {}
	try {
		const parsed = JSON.parse(text)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new MiniAppBadRequest('请求体必须是 JSON 对象')
		}
		return parsed
	} catch (error) {
		if (error instanceof MiniAppBadRequest) throw error
		throw new MiniAppBadRequest('请求体不是合法 JSON')
	}
}

/** Map a thrown error onto an HTTP status, keeping the operator's message. */
function errorStatus(error) {
	if (error instanceof MiniAppNotFound) return 404
	if (error instanceof MiniAppBadRequest) return 400
	return 500
}

function errorMessage(error) {
	if (error instanceof MiniAppNotFound || error instanceof MiniAppBadRequest) return error.message
	return '小程序服务内部错误'
}

/** A stable-id string for the session that asked, when the executor offers one. */
function sessionIdOf(exec) {
	try {
		const id = exec?.agent?.session?.id
		if (id === undefined || id === null) return null
		return typeof id === 'string' ? id : String(id)
	} catch {
		return null
	}
}

/** The asking session's workspace root, when the executor exposes one. */
function workspaceRootOf(exec) {
	try {
		const cwd = exec?.agent?.session?.header?.cwd
		return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
	} catch {
		return undefined
	}
}

/**
 * Confine a caller-supplied path to the asking session's own workspace.
 *
 * The import/validate tools are the only place this plugin touches a path it
 * did not derive itself, so they are the only place it could be talked into
 * reading something the session was never allowed to see. The tools run in the
 * host, where `node:fs` is not subject to the session's file policy — so the
 * boundary has to be enforced here, by hand, or not at all.
 *
 * Fails CLOSED: a session with no resolvable workspace gets a refusal, not a
 * free pass.
 */
async function resolveInsideWorkspace(exec, candidate) {
	const root = workspaceRootOf(exec)
	if (root === undefined) {
		throw new MiniAppBadRequest('这个会话没有可解析的工作区，无法安全地读取外部文件')
	}
	if (!isAbsolute(candidate)) throw new MiniAppBadRequest('path 必须是绝对路径')
	// **词法前缀判断不够。** `resolve()` 只做字符串归一化，不解析符号链接：工作区里一个
	// `innocent.html -> /etc/passwd`（或一个指向外部目录的目录链接）就能让这条守卫放行，
	// 把工作区外的文件读进库、再经 `read_source` 回给模型 —— 而这段守卫的全部意义就是
	// 阻止这件事（工具跑在宿主里，不受会话文件沙箱约束）。
	//
	// 所以两边都取 `realpath`（解析掉链接与 `..`）之后再比较。目标不存在时 `realpath`
	// 会抛 ENOENT —— 那也应当拒绝：读不到的东西没有"在工作区内"可言。
	const { realpath } = await import('node:fs/promises')
	const base = await realpath(resolve(root)).catch(() => resolve(root))
	const target = await realpath(resolve(candidate)).catch(() => {
		throw new MiniAppBadRequest(`读不到文件：${candidate}（不存在，或不可访问）`)
	})
	if (target !== base && !target.startsWith(base.endsWith(sep) ? base : base + sep)) {
		throw new MiniAppBadRequest(`只能导入会话工作区内的文件：${candidate} 不在 ${base} 之内`)
	}
	return target
}

/**
 * Register the model-visible tool surface.
 *
 * Every tool answers with a plain JSON value matching its declared schema; the
 * human-readable form is produced by `render`, which is a pure function of the
 * arguments and the value.
 */
function registerTools(ctx, store, config) {
	const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

	/**
	 * The wire shape of one mini-app.
	 *
	 * Two constraints of DSH's value-schema DSL are load-bearing here, and both
	 * are enforced loudly at registration time rather than at call time:
	 *
	 *  - **No `required`.** The DSL compiles value schemas with
	 *    `allowRequired: false` at every level, so a `required: [...]` array is
	 *    rejected outright with `UNSUPPORTED_SCHEMA` — unlike the `parameters`
	 *    DSL, where `required: true` is a per-property flag. Presence is
	 *    therefore documented in the descriptions, not asserted.
	 *  - **No array-valued `type`.** `type: ['string', 'null']` matches no
	 *    branch of the compiler's switch; a nullable field is spelled as a
	 *    `oneOf` over two scalar nodes.
	 */
	const APP_SHAPE = {
		type: 'object',
		additionalProperties: false,
		properties: {
			miniapp_id: { type: 'string', description: '小程序的裸小写 UUIDv7。' },
			name: { type: 'string', description: '显示名称。' },
			description: { type: 'string', description: '一句话说明，可能为空串。' },
			icon: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'emoji 图标，未设置时为 null。' },
			html_size: { type: 'number', description: '已发布快照的字节数。' },
			published_at: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '发布时间（ms epoch）；从未发布时为 null。' },
			created_at: { type: 'number' },
			updated_at: { type: 'number' },
			source_path: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '工作副本的绝对路径，交给会话去编辑。' },
			source_session_id: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '创建它的会话 id，纯溯源；从不用于跳转。' },
			has_unpublished_changes: { type: 'boolean', description: '工作副本是否领先于已发布快照。' }
		}
	}

	/** 一条校验发现。永远嵌在数组里，因此同样不能带 `required`。 */
	const FINDING_SHAPE = {
		type: 'object',
		additionalProperties: false,
		properties: {
			rule_id: { type: 'string' },
			severity: { type: 'string', description: 'fatal / autofix / warning 之一。' },
			detail: { type: 'string', description: '结构化细节（命中的引用、实际字节数等），可能缺省。' }
		}
	}

	ctx.tools.register(defineTool({
		name: 'miniapp_create',
		description: [
			'新建一个小程序（自包含单文件网页小工具）。',
			'用它来响应用户「做一个小程序 / 小工具 / 番茄钟 / 待办 / 计算器」这类诉求：',
			'先建，再用 miniapp_write_source 把 HTML 写进去，最后告诉用户去「小程序」面板点发布。',
			'不要用 TypeScript、npm 依赖或多文件工程 —— 小程序就是一个 HTML 文件。'
		].join(''),
		parameters: {
			name: {
				type: 'string',
				required: true,
				description: '小程序名称，会显示在库卡片上。'
			},
			description: {
				type: 'string',
				description: '一句话说明它能做什么（可选）。'
			},
			icon: {
				type: 'string',
				description: '一个 emoji 作为图标（可选）。'
			},
			html: {
				type: 'string',
				description: '可选的初始 HTML 全文。省略时只创建工作副本骨架，之后再用 write 写入。'
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					miniapp_id: { type: 'string' },
					name: { type: 'string' },
					source_path: { type: 'string' },
					contract: { type: 'string' }
				},
			},
			render: (_args, value) => text([
				`已创建小程序「${value.name}」`,
				`id: ${value.miniapp_id}`,
				`源码绝对路径: ${value.source_path}`,
				'',
				value.contract
			].join('\n'))
		},
		async execute(args, exec) {
			if (exec?.signal?.aborted) throw new Error('aborted')
			const app = await store.create({
				name: args.name,
				description: args.description,
				icon: args.icon,
				html: args.html,
				source_session_id: sessionIdOf(exec) ?? undefined
			})
			const sourcePath = await store.ensureWorkingCopy(app.miniapp_id)
			return {
				miniapp_id: app.miniapp_id,
				name: app.name,
				source_path: sourcePath,
				contract: BUILDER_CONTRACT
			}
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_list',
		description: '列出用户已有的全部小程序（名称、描述、最近更新时间、是否有未发布改动）。',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					apps: { type: 'array', items: APP_SHAPE },
					total: { type: 'number' }
				},
			},
			render: (_args, value) => {
				if (value.total === 0) return text('用户还没有任何小程序。')
				const lines = value.apps.map((app) => {
					const dirty = app.has_unpublished_changes ? '（有未发布改动）' : ''
					return `- ${app.icon ? `${app.icon} ` : ''}${app.name}${dirty} — ${app.miniapp_id}`
				})
				return text([`共 ${value.total} 个小程序：`, ...lines].join('\n'))
			}
		},
		async execute() {
			const apps = await store.list()
			return { apps, total: apps.length }
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_get',
		description: '读取一个小程序的元数据，包括源码绝对路径与是否有未发布改动。',
		parameters: {
			miniapp_id: { type: 'string', required: true, description: '小程序 id。' }
		},
		output: { schema: APP_SHAPE, render: (_args, value) => text(JSON.stringify(value, null, 2)) },
		async execute(args) {
			return store.getProjected(args.miniapp_id)
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_iterate',
		description: [
			'开始继续迭代一个小程序：物化它的工作副本。',
			'然后先用 miniapp_read_source 完整读一遍，再用 miniapp_write_source 写回完整的一版；只动这一个文件。',
			'改完不会自动生效，用户需要在「小程序」面板点「发布」。'
		].join(''),
		parameters: {
			miniapp_id: { type: 'string', required: true, description: '小程序 id。' }
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					miniapp_id: { type: 'string' },
					name: { type: 'string' },
					source_path: { type: 'string' },
					contract: { type: 'string' }
				},
			},
			render: (_args, value) => text([
				`小程序「${value.name}」已就绪。`,
				`源码路径：${value.source_path}`,
				'（它在会话工作区之外，直接用 read/write 会被文件沙箱拒绝 —— 请用 miniapp_read_source / miniapp_write_source。）',
				'',
				'先完整读一遍再改，只改这一个文件。',
				'',
				value.contract
			].join('\n'))
		},
		async execute(args) {
			const app = await store.getProjected(args.miniapp_id)
			const sourcePath = await store.ensureWorkingCopy(args.miniapp_id)
			return { miniapp_id: app.miniapp_id, name: app.name, source_path: sourcePath, contract: BUILDER_CONTRACT }
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_read_source',
		description: [
			'读取一个小程序当前的源码全文。',
			'小程序源码位于会话工作区之外，默认的 workspace-write 文件沙箱不允许直接用 read 读它 —— 用这个工具。',
			'改之前先完整读一遍。'
		].join(''),
		parameters: {
			miniapp_id: { type: 'string', required: true, description: '小程序 id。' }
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					miniapp_id: { type: 'string' },
					name: { type: 'string' },
					html: { type: 'string', description: '工作副本全文；还没有内容时是空串。' },
					bytes: { type: 'number', description: '工作副本的字节数。' },
					has_unpublished_changes: { type: 'boolean' }
				}
			},
			render: (_args, value) => text(value.html.length === 0
				? `小程序「${value.name}」的工作副本还是空的 —— 用 miniapp_write_source 把第一版写进去。`
				: value.html)
		},
		async execute(args) {
			const app = await store.getProjected(args.miniapp_id)
			const html = (await store.readWorkingCopy(args.miniapp_id)) ?? ''
			return {
				miniapp_id: app.miniapp_id,
				name: app.name,
				html,
				bytes: Buffer.byteLength(html, 'utf8'),
				has_unpublished_changes: app.has_unpublished_changes
			}
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_write_source',
		description: [
			'把小程序源码全文写进它的工作副本（整份替换）。',
			'小程序源码位于会话工作区之外，默认的 workspace-write 文件沙箱不允许直接用 write/edit 改它 —— 用这个工具。',
			'写完整的一份：它不做增量编辑。写完不会自动上线，用户要在「小程序」面板点「发布」。'
		].join(''),
		parameters: {
			miniapp_id: { type: 'string', required: true, description: '小程序 id。' },
			html: { type: 'string', required: true, description: '这份小程序的完整 HTML 全文（自包含单文件）。' }
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					miniapp_id: { type: 'string' },
					name: { type: 'string' },
					bytes: { type: 'number' },
					needs_publish: { type: 'boolean', description: '恒为 true：写完必须由用户点发布才会上线。' }
				}
			},
			render: (_args, value) => text(
				`已写入小程序「${value.name}」的源码（${value.bytes} 字节）。现在提醒用户去「小程序」面板点「发布」，改动才会生效。`
			)
		},
		async execute(args) {
			// Base validation only. The document-shape gate belongs to `publish`:
			// an iteration may legitimately pass through states here, and the thing
			// that must never ship half a document is the publish act, not the edit.
			const html = MiniAppStore.validateHtml(args.html)
			const app = await store.get(args.miniapp_id)
			await store.writeWorkingCopy(args.miniapp_id, html)
			return {
				miniapp_id: app.miniapp_id,
				name: app.name,
				bytes: Buffer.byteLength(html, 'utf8'),
				needs_publish: true
			}
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_publish',
		description: [
			'把小程序的工作副本发布成线上版本（工作副本 → 已发布快照）。',
			'只在用户明确要求发布时使用；通常应该由用户在「小程序」面板里自己点发布。',
			'如果工作副本还不是一个完整的 HTML 文档，发布会失败并说明原因。'
		].join(''),
		parameters: {
			miniapp_id: { type: 'string', required: true, description: '小程序 id。' }
		},
		output: { schema: APP_SHAPE, render: (_args, value) => text(`已发布「${value.name}」，当前运行的就是这一版（${value.html_size} 字节）。`) },
		async execute(args) {
			return store.publish(args.miniapp_id)
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_delete',
		description: '删除一个小程序，连同它的已发布快照、工作副本与目录。不可恢复。',
		parameters: {
			miniapp_id: { type: 'string', required: true, description: '小程序 id。' }
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					miniapp_id: { type: 'string' },
					name: { type: 'string' },
					deleted: { type: 'boolean' }
				},
			},
			render: (_args, value) => text(`已删除小程序「${value.name}」。`)
		},
		async execute(args) {
			const removed = await store.remove(args.miniapp_id)
			return { ...removed, deleted: true }
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_validate',
		description: [
			'检查一个已有的 HTML 文件能不能作为小程序导入，返回结构化的问题清单。',
			'不写入任何东西。用来在导入前回答「我这个页面能不能托管成小程序」。'
		].join(''),
		parameters: {
			path: { type: 'string', required: true, description: '要检查的 HTML 文件绝对路径。' }
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					blocked: { type: 'boolean' },
					applied_fixes: { type: 'array', items: { type: 'string' } },
					findings: { type: 'array', items: FINDING_SHAPE }
				},
			},
			render: (_args, value) => {
				if (value.findings.length === 0) return text('检查通过，没有发现问题。')
				const lines = value.findings.map((f) => `- [${f.severity}] ${f.rule_id}${f.detail ? `: ${f.detail}` : ''}`)
				return text([value.blocked ? '存在必须先解决的问题，无法导入：' : '检查完成：', ...lines].join('\n'))
			}
		},
		async execute(args, exec) {
			const { readFile, stat } = await import('node:fs/promises')
			const path = await resolveInsideWorkspace(exec, args.path)
			// 先 stat 再读：`validateHtml` 的 4 MiB 上限在**读完之后**才判，工作区里放一个
			// 几 GB 的文件会让这一步整份读成字符串（宿主内存与事件循环一起遭殃）。
			const info = await stat(path).catch(() => undefined)
			if (info === undefined || !info.isFile()) throw new MiniAppBadRequest(`读不到文件：${path}`)
			if (info.size > HTML_MAX_BYTES) {
				throw new MiniAppBadRequest(`文件超过 ${HTML_MAX_BYTES} 字节上限：${path}`)
			}
			const html = await readFile(path, 'utf8').catch(() => {
				throw new MiniAppBadRequest(`读不到文件：${path}`)
			})
			const report = validateImport(html, [])
			const fixed = applyFixes(html, report)
			return {
				blocked: report.blocked,
				applied_fixes: fixed.applied,
				findings: report.findings
			}
		}
	}))

	ctx.tools.register(defineTool({
		name: 'miniapp_import',
		description: [
			'把一个用户自己写好的 HTML 文件托管成小程序（校验 → 修正片段 → 入库）。',
			'文件必须是一个自包含的 HTML 文档；如果有必须解决的问题，会拒绝导入并给出清单。'
		].join(''),
		parameters: {
			path: { type: 'string', required: true, description: 'HTML 文件绝对路径。' },
			name: { type: 'string', description: '小程序名称。省略时按 <title> 或文件名推断。' },
			description: { type: 'string', description: '一句话说明（可选）。' },
			icon: { type: 'string', description: '一个 emoji 图标（可选）。' }
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					miniapp_id: { type: 'string' },
					name: { type: 'string' },
					source_path: { type: 'string' },
					applied_fixes: { type: 'array', items: { type: 'string' } },
					findings: { type: 'array', items: { type: 'object', additionalProperties: true } }
				},
			},
			render: (_args, value) => text([
				`已导入「${value.name}」（${value.miniapp_id}）。`,
				value.applied_fixes.length > 0 ? `导入时自动处理：${value.applied_fixes.join('、')}` : '',
				'已经可以直接在「小程序」面板里打开使用；想继续改就点「继续迭代」。'
			].filter((line) => line.length > 0).join('\n'))
		},
		async execute(args, exec) {
			const { readFile, stat } = await import('node:fs/promises')
			const { basename } = await import('node:path')
			const path = await resolveInsideWorkspace(exec, args.path)
			const info = await stat(path).catch(() => undefined)
			if (info === undefined || !info.isFile()) throw new MiniAppBadRequest(`读不到文件：${path}`)
			if (info.size > HTML_MAX_BYTES) {
				throw new MiniAppBadRequest(`这个文件超过 ${HTML_MAX_BYTES} 字节上限，不能作为小程序导入：${path}`)
			}
			const raw = await readFile(path, 'utf8').catch(() => {
				throw new MiniAppBadRequest(`读不到文件：${path}`)
			})
			const report = validateImport(raw, [])
			if (report.blocked) {
				// Refuse, but hand back the findings so the caller can act on them
				// instead of guessing what "400" meant.
				const reason = report.findings.filter((f) => f.severity === 'fatal').map((f) => f.rule_id).join('、')
				throw new MiniAppBadRequest(`这个文件还不能作为小程序导入，必须先解决：${reason}`)
			}
			const { html, applied } = applyFixes(raw, report)
			const app = await store.create({
				name: clampName(args.name ?? suggestName(html, basename(path))),
				description: args.description,
				icon: args.icon,
				html
			})
			return {
				miniapp_id: app.miniapp_id,
				name: app.name,
				source_path: store.workingCopyPath(app.miniapp_id),
				applied_fixes: applied,
				findings: report.findings
			}
		}
	}))

	ctx.logger.info(`[dsh-miniapp] tools registered; data dir ${config.dataDir}`)
}

/**
 * Build the height-reporting script injected for `?embed=1`.
 *
 * It does exactly three things, and nothing else:
 *
 *  1. measure `documentElement.scrollHeight` and `body.scrollHeight` and take
 *     the larger of the two (a page may size either one);
 *  2. `parent.postMessage({ type, height }, '*')`;
 *  3. re-send when the height changes, via `ResizeObserver` when available and
 *     `window.resize` otherwise (the latter only catches viewport changes — a
 *     degradation, not an equivalent).
 *
 * It does NOT read page content, touch the network, or write any storage. That
 * restraint is the deal that makes injecting it acceptable at all: the app stays
 * "the document the user published", plus one measurement.
 *
 * `targetOrigin` is `"*"` because a sandboxed document without
 * `allow-same-origin` lives in an opaque origin: its `origin` is the string
 * `"null"`, so naming a real origin would make the message impossible to send.
 * The parent claims it by `event.source` instead (see the client half), which is
 * the only thing an opaque-origin frame cannot forge.
 *
 * This runs in the browser, not in Node — it is a string that travels to the
 * client. Keep it ES5-shaped: the frame's document has no build step.
 */
export function runnerMeasureScript() {
	return [
		'<script>(function(){',
		`var TYPE=${JSON.stringify(RUNNER_HEIGHT_MESSAGE_TYPE)};`,
		'function measure(){',
		'var root=document.documentElement,body=document.body;',
		'var height=Math.max(',
		'root&&root.scrollHeight?root.scrollHeight:0,',
		'body&&body.scrollHeight?body.scrollHeight:0);',
		'if(!(height>0))return;',
		'parent.postMessage({type:TYPE,height:height},"*");',
		'}',
		'measure();',
		// Fonts and images arriving late change the height; measure again on load.
		'window.addEventListener("load",measure);',
		'if(typeof ResizeObserver==="function"){',
		'try{new ResizeObserver(measure).observe(document.documentElement);}catch(e){measure();}',
		'}else{window.addEventListener("resize",measure);}',
		'})()</script>'
	].join('')
}

/**
 * Insert the height script into a served document.
 *
 * Same three-step placement as the preview half: before `</body>`, else before
 * `</html>`, else appended. Case-insensitive, because a document may well say
 * `</BODY>`. A document with neither closing tag is still a document — the
 * browser synthesises the missing elements and the trailing script runs anyway.
 *
 * Returns the ORIGINAL string untouched when there is nothing to measure or
 * nothing to inject into, so callers can compare identity rather than guess.
 */
export function withRunnerMeasure(html, script) {
	if (typeof html !== 'string' || html === '') return html
	let at = html.search(/<\/body\s*>/i)
	if (at < 0) at = html.search(/<\/html\s*>/i)
	if (at < 0) return html + script
	return html.slice(0, at) + script + html.slice(at)
}

/**
 * Register the HTTP surface: the library API the overlay drives, plus the
 * capability-URL document channel the runner iframe loads.
 */
function registerRoutes(ctx, store, config) {
	/** Strip the route's own prefix and hand the handler a relative path. */
	const viaPrefix = (prefix, handler) => (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const relative = url.pathname.slice(prefix.length) || '/'
		return handler(req, res, relative, (req.method ?? 'GET').toUpperCase(), url.searchParams)
	}

	// ---- the document channel -------------------------------------------------
	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: SERVE_PREFIX,
		handler: viaPrefix(SERVE_PREFIX, async (req, res, path, method, searchParams) => {
			try {
				if (method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
				// 坏百分号编码（`/serve/%`）是**客户端输入错误**，不是内部故障：
				// 原样让 URIError 冒到最外层会回 500 并打一条 ERROR 堆栈。
				let miniappId
				try {
					miniappId = decodeURIComponent(path.replace(/^\//, ''))
				} catch {
					return json(res, 400, { ok: false, error: '小程序 id 不是合法的 URL 编码' })
				}
				if (!isMiniAppId(miniappId)) return json(res, 400, { ok: false, error: 'bad miniapp_id' })
				const html = await store.readSnapshot(miniappId)
				if (html === undefined) {
					// A clean 404, never a 401/403: an auth error would reveal that the
					// route exists but is guarded, which is the thing the capability-URL
					// design avoids.
					//
					// 但"干净"不等于"用数据形状回答"：这个响应体的读者是**浏览器的文档视图**，
					// 一段 JSON 会被内联渲染成纯文本（就是缺陷报告里"预览区显示原始 JSON"）。
					// 所以这里换成人话文档 —— 状态码、缓存与 nosniff 都不变。
					return sendHtml(res, 404, notPublishedDocument())
				}
				// The one thing a query parameter is allowed to change. Without it the
				// response body is the snapshot object read from disk, byte for byte —
				// no trimming, no normalising, no rewriting. Tests pin that identity,
				// because "the running document is the published document" is a promise
				// this channel makes to every user who presses Publish and then looks
				// at the frame.
				//
				// Only the exact single `embed=1` counts. A repeated parameter
				// (`?embed=1&embed=0`) is not "obviously yes": nothing stops a client
				// from appending a second copy, and the safe reading of an ambiguous
				// request is the one that injects NOTHING.
				const embedValues = searchParams === undefined || searchParams === null
					? []
					: searchParams.getAll('embed')
				const embed = embedValues.length === 1 && embedValues[0] === EMBED_VALUE
				const body = embed ? withRunnerMeasure(html, runnerMeasureScript()) : html
				// `removeHeader` BEFORE `writeHead`. Calling it afterwards throws
				// ERR_HTTP_HEADERS_SENT, and by then the response can no longer be
				// corrected — the socket is simply dropped (curl reports "Empty reply
				// from server") and nothing is logged but the stack.
				res.removeHeader('x-frame-options')
				// NOTE: the headers below are identical in both modes. `embed` changes
				// the body and nothing else — in particular the sandbox directive is
				// untouched, and `allow-scripts` was already there (a mini-app IS
				// script), so the injected measurement script needs no new grant.
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					// Private but revalidated on every load: the same id serves a new
					// document after every publish, and an iterating user must see the
					// version they just shipped.
					'cache-control': 'private, no-cache',
					'x-content-type-options': 'nosniff',
					// The sandbox directive is set HERE, not only on the iframe
					// attribute, so the document is sandboxed no matter how it is
					// reached — including a direct navigation, or a frame created by
					// markup we do not control.
					'content-security-policy': `sandbox ${IFRAME_SANDBOX}; frame-ancestors 'self'`
				})
				res.end(body)
			} catch (error) {
				ctx.logger.error(`[dsh-miniapp] serve failed: ${String(error?.stack ?? error)}`)
				if (!res.headersSent) json(res, 500, { ok: false, error: '小程序直出通道内部错误' })
			}
		})
	}), 'dsh-miniapp: document channel route')

	// ---- the library API ------------------------------------------------------
	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: API_PREFIX,
		handler: viaPrefix(API_PREFIX, async (req, res, path, method) => {
			try {
				const mutating = method !== 'GET' && method !== 'HEAD'
				if (mutating ? !isTrustedMutation(req) : !isTrustedRead(req)) {
					return json(res, 403, { ok: false, error: '请求来源不受信任' })
				}

				// 用户偏好（会话标题栏上固定哪一个小程序）。
				//
				// 为什么不放客户端 localStorage：那不是 DSH 的插件契约，而"固定"是用户
				// 明确的意图、重载页面不该丢。宿主的 HTTP 通道 + dataDir 是现成的去处，
				// 也没有引入任何新的耦合。
				if (path === '/prefs') {
					if (method === 'GET') return json(res, 200, { ok: true, data: await store.readPrefs() })
					if (method === 'POST' || method === 'PATCH') {
						if (!isTrustedMutation(req)) {
							return json(res, 403, { ok: false, error: '请求来源不受信任' })
						}
						const body = await readJsonBody(req)
						return json(res, 200, { ok: true, data: await store.writePrefs(body) })
					}
					return json(res, 405, { ok: false, error: '方法不被允许' })
				}

				if (path === '/health') {
					if (method !== 'GET') return json(res, 405, { ok: false, error: '方法不被允许' })
					// **不回 dataDir。** 读端点不带 Origin 也放行（本地进程本来就能直接读盘），
					// 而绝对路径没有任何理由交给每一个能连上这个端口的调用方。
					return json(res, 200, { ok: true, data: { ok: true } })
				}

				// 模板目录是纯静态只读数据，不进 store：它不随用户数据变化，也不
				// 需要 dataDir。列表刻意**不含 html** —— 挑模板的面板要铺十二张卡片，
				// 没有理由为此下载十二份完整文档，正文等选中之后按 id 取一次。
				if (path === '/templates') {
					if (method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
					return json(res, 200, { ok: true, data: TEMPLATE_SUMMARIES })
				}

				if (path.startsWith('/templates/')) {
					if (method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
					let templateId
					try {
						templateId = decodeURIComponent(path.slice('/templates/'.length))
					} catch {
						return json(res, 400, { ok: false, error: '模板 id 不是合法的 URL 编码' })
					}
					const template = findTemplate(templateId)
					if (template === undefined) return json(res, 404, { ok: false, error: '没有这个模板' })
					return json(res, 200, { ok: true, data: template })
				}

				if (path === '/apps') {
					if (method === 'GET') return json(res, 200, { ok: true, data: await store.list() })
					if (method === 'POST') {
						const body = await readJsonBody(req)
						const app = await store.create(body)
						await store.ensureWorkingCopy(app.miniapp_id)
						return json(res, 200, { ok: true, data: app })
					}
					return json(res, 405, { ok: false, error: 'method not allowed' })
				}

				if (path === '/validate') {
					if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
					const body = await readJsonBody(req)
					if (typeof body.html !== 'string') throw new MiniAppBadRequest('需要给出 html')
					const report = validateImport(body.html, [])
					const fixed = applyFixes(body.html, report)
					return json(res, 200, { ok: true, data: { ...report, applied_fixes: fixed.applied, html: fixed.html } })
				}

				if (path === '/import') {
					if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
					const body = await readJsonBody(req)
					if (typeof body.html !== 'string') throw new MiniAppBadRequest('需要给出 html')
					const report = validateImport(body.html, [])
					const fixed = applyFixes(body.html, report)
					if (report.blocked) {
						// Refuse, but hand back the findings: a bare status code would make
						// the caller ask a second time.
						return json(res, 400, {
							ok: false,
							error: '文件里还有必须先解决的问题',
							data: { report, applied_fixes: fixed.applied }
						})
					}
					const app = await store.create({
						name: clampName(body.name ?? suggestName(fixed.html, body.file_name)),
						description: body.description,
						icon: body.icon,
						html: fixed.html
					})
					return json(res, 200, { ok: true, data: { app, report, applied_fixes: fixed.applied } })
				}

				const appMatch = /^\/apps\/([^/]+)(\/[a-z]+)?$/.exec(path)
				if (appMatch !== null) {
					let miniappId
					try {
						miniappId = decodeURIComponent(appMatch[1])
					} catch {
						return json(res, 400, { ok: false, error: '小程序 id 不是合法的 URL 编码' })
					}
					if (!isMiniAppId(miniappId)) throw new MiniAppBadRequest('miniapp_id 不是合法的裸小写 UUIDv7')
					const action = appMatch[2]
					if (action === undefined) {
						if (method === 'GET') return json(res, 200, { ok: true, data: await store.getProjected(miniappId) })
						if (method === 'POST' || method === 'PATCH') {
							return json(res, 200, { ok: true, data: await store.update(miniappId, await readJsonBody(req)) })
						}
						if (method === 'DELETE') {
							// Same envelope as the 工具: the caller learns which app went away,
							// and `deleted` states the fact rather than implying it.
							return json(res, 200, { ok: true, data: { ...(await store.remove(miniappId)), deleted: true } })
						}
						return json(res, 405, { ok: false, error: 'method not allowed' })
					}
					if (action === '/publish') {
						if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
						return json(res, 200, { ok: true, data: await store.publish(miniappId) })
					}
					if (action === '/iterate') {
						if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
						const sourcePath = await store.ensureWorkingCopy(miniappId)
						return json(res, 200, { ok: true, data: { source_path: sourcePath, contract: BUILDER_CONTRACT } })
					}
					if (action === '/source') {
						if (method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
						const source = await store.readWorkingCopy(miniappId)
						return json(res, 200, { ok: true, data: { html: source ?? null } })
					}
					return json(res, 404, { ok: false, error: 'unknown action' })
				}

				return json(res, 404, { ok: false, error: 'not found' })
			} catch (error) {
				const status = errorStatus(error)
				if (status === 500) ctx.logger.error(`[dsh-miniapp] ${String(error?.stack ?? error)}`)
				if (res.headersSent) return undefined
				return json(res, status, { ok: false, error: errorMessage(error) })
			}
		})
	}), 'dsh-miniapp: library API route')

	ctx.logger.info(`[dsh-miniapp] routes registered under ${API_PREFIX} and ${SERVE_PREFIX}`)
}

export function apply(ctx, config) {
	const dataDir = resolve(config.dataDir)
	const store = new MiniAppStore(dataDir)

	// Kick off the index load, but never let a slow or corrupt file block plugin
	// activation: a failure must surface on the first real request, not as a
	// FAILED boot the user cannot diagnose.
	void store.load().catch((error) => {
		ctx.logger.error(`[dsh-miniapp] failed to load ${join(dataDir, 'index.json')}: ${String(error?.message ?? error)}`)
	})

	registerTools(ctx, store, { ...config, dataDir })

	// `/create-miniapp`：让用户从输入框一步走到"建一个小程序"。
	//
	// 包在 `ctx.effect` 里不是形式主义：`skills.register` 注册的是**运行时**技能
	// （provider 为 `runtime`），它在这个 context 的层里活着，只有当插件卸载时被
	// 撤销——否则同名技能会一直挂在那儿，重装后先到先得，新的那份反而被忽略
	// （`dsh-skill` 的 register：同层同名运行时注册 first-wins，重复注册拿到一个
	// no-op disposer）。这里没有"注册两次"的机会，但撤销依然是这条链路的正解。
	ctx.effect(() => ctx.skills.register(CREATE_MINIAPP_SKILL), 'dsh-miniapp: create-miniapp skill')

	// The web server is optional: a headless/CLI deployment still gets the tools
	// and the store, and simply has no browser surface to serve.
	ctx.inject(['webServer'], (webCtx) => registerRoutes(webCtx, store, { ...config, dataDir }))
}

export { MiniAppStore, MiniAppBadRequest, MiniAppNotFound, HTML_MAX_BYTES }
export { validateImport, looksLikeHtmlDocument } from './validate.js'
// 模板目录也从这个入口出得去：`package.json` 的 exports 只开了 `.` 与 `./client`，
// 宿主侧要读它就只能走这里。
export { MINIAPP_TEMPLATES, TEMPLATE_CATEGORIES, TEMPLATE_SUMMARIES, findTemplate } from './templates.js'
