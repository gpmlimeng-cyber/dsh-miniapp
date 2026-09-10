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
/** Tools are the whole model-facing surface; the service is optional. */
export const inject = ['tools']

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

/** Grace period before the runner admits a frame may be stuck, in ms. */
export const LOAD_WATCHDOG_MS = 6000

/** Default data directory: `{DSH_HOME}/miniapp`. */
const DEFAULT_DATA_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'miniapp')

/**
 * Configuration surface. Everything tunable lives here rather than in the code,
 * so a deployment can retune it from a cordis.yml patch.
 */
export const Config = Schema.object({
	dataDir: Schema.string().default(DEFAULT_DATA_DIR).description('小程序数据目录（索引 + 每个小程序的快照与工作副本）'),
	showSidebarEntry: Schema.boolean().default(true).description('在左侧栏底部显示「小程序」入口'),
	watchdogMs: Schema.number().default(LOAD_WATCHDOG_MS).description('运行页判定 iframe 卡住的宽限毫秒数')
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

function json(res, status, body) {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff'
	})
	res.end(text)
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
		if (size > limitBytes) throw new MiniAppBadRequest('请求体过大')
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
function resolveInsideWorkspace(exec, candidate) {
	const root = workspaceRootOf(exec)
	if (root === undefined) {
		throw new MiniAppBadRequest('这个会话没有可解析的工作区，无法安全地读取外部文件')
	}
	if (!isAbsolute(candidate)) throw new MiniAppBadRequest('path 必须是绝对路径')
	const base = resolve(root)
	const target = resolve(candidate)
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
			const { readFile } = await import('node:fs/promises')
			const path = resolveInsideWorkspace(exec, args.path)
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
			const { readFile } = await import('node:fs/promises')
			const { basename } = await import('node:path')
			const path = resolveInsideWorkspace(exec, args.path)
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
 * Register the HTTP surface: the library API the overlay drives, plus the
 * capability-URL document channel the runner iframe loads.
 */
function registerRoutes(ctx, store, config) {
	/** Strip the route's own prefix and hand the handler a relative path. */
	const viaPrefix = (prefix, handler) => (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const relative = url.pathname.slice(prefix.length) || '/'
		return handler(req, res, relative, (req.method ?? 'GET').toUpperCase())
	}

	// ---- the document channel -------------------------------------------------
	ctx.webServer.register({
		kind: 'prefix',
		path: SERVE_PREFIX,
		handler: viaPrefix(SERVE_PREFIX, async (req, res, path, method) => {
			try {
				if (method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
				const miniappId = decodeURIComponent(path.replace(/^\//, ''))
				if (!isMiniAppId(miniappId)) return json(res, 400, { ok: false, error: 'bad miniapp_id' })
				const html = await store.readSnapshot(miniappId)
				if (html === undefined) {
					// A clean 404, never a 401/403: an auth error would reveal that the
					// route exists but is guarded, which is the thing the capability-URL
					// design avoids.
					return json(res, 404, { ok: false, error: 'mini-app has no published snapshot' })
				}
				// `removeHeader` BEFORE `writeHead`. Calling it afterwards throws
				// ERR_HTTP_HEADERS_SENT, and by then the response can no longer be
				// corrected — the socket is simply dropped (curl reports "Empty reply
				// from server") and nothing is logged but the stack.
				res.removeHeader('x-frame-options')
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
				res.end(html)
			} catch (error) {
				ctx.logger.error(`[dsh-miniapp] serve failed: ${String(error?.stack ?? error)}`)
				if (!res.headersSent) json(res, 500, { ok: false, error: '小程序直出通道内部错误' })
			}
		})
	})

	// ---- the library API ------------------------------------------------------
	ctx.webServer.register({
		kind: 'prefix',
		path: API_PREFIX,
		handler: viaPrefix(API_PREFIX, async (req, res, path, method) => {
			try {
				const mutating = method !== 'GET' && method !== 'HEAD'
				if (mutating ? !isTrustedMutation(req) : !isTrustedRead(req)) {
					return json(res, 403, { ok: false, error: '请求来源不受信任' })
				}

				if (path === '/health') {
					return json(res, 200, { ok: true, data: { dataDir: config.dataDir } })
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
					const template = findTemplate(decodeURIComponent(path.slice('/templates/'.length)))
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
					const miniappId = decodeURIComponent(appMatch[1])
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
	})

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

	// The web server is optional: a headless/CLI deployment still gets the tools
	// and the store, and simply has no browser surface to serve.
	ctx.inject(['webServer'], (webCtx) => registerRoutes(webCtx, store, { ...config, dataDir }))
}

export { MiniAppStore, MiniAppBadRequest, MiniAppNotFound, HTML_MAX_BYTES }
export { validateImport, looksLikeHtmlDocument } from './validate.js'
// 模板目录也从这个入口出得去：`package.json` 的 exports 只开了 `.` 与 `./client`，
// 宿主侧要读它就只能走这里。
export { MINIAPP_TEMPLATES, TEMPLATE_CATEGORIES, TEMPLATE_SUMMARIES, findTemplate } from './templates.js'
