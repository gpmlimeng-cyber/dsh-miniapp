// dsh-miniapp — 宿主半边集成测试。
//
// 用最小的假 Cordis ctx 调真正的 `apply()`，然后：验证工具与路由都注册成功、
// 直接调用工具的 `execute` 跑完整流程、再拿真的 HTTP handler 打一遍。
//
// 这是「装进 profile 之前」的最后一关：Syntax OK 不代表契约对（defineTool 的
// schema 是否合法、路由 kind/path 是否正确、参数提取是否与声明一致），这里能抓到。
//
// ─────────────────────────────────────────────────────────────────────────────
// 文件末尾那组「skill 注册契约」用的**不是假替身**：它从已安装的 asar 里把真实的
// `@deepseek-ai/dsh-skill` 连同依赖闭包抽到临时目录、`import()` 真入口、挂在真实的
// cordis `Context` 上跑 `register / list / get`。
//
// 为什么非要有这一层（而不是只测我们自己的假 ctx）：**假替身是我们自己写的，于是
// 我们不知道的东西它也照样不知道。** 本项目的 F1 就是这么溜过 155 条全绿的：
// 技能对象少了 `source` 字段，`register` 不校验、`list` 照样列得出来（目录条目只是拷
// 一遍字段），只有真实服务的 `get()` 会抛 —— 而 `get` 正是"用户敲 `/create-miniapp`
// 之后把正文注入模型上下文"走的那条路。单测能证明的只有"注册被调用"。
//
// ⚠️ **显式降级（别把"没常驻"读成"没验证"）**：这里常驻的是
// 「**真实服务实现 + 真实 Context**」，**不是**完整进程 ——
// 「隔离 DSH_HOME + 用 asar 里的 dsh CLI 起一次性 profile、在真实宿主进程里断言
// `skills.list/get`」那一层**没有**进仓库（它需要起进程、依赖 CLI 与 profile 形状）。
// 完整的 agent 回合（模型真的读到正文）同样不在这一层。那两层此前各做过一次人工验证，
// 但没有常驻；要补，就照这里的 `loadAsar` + `DSH_ASAR` 覆盖那条路扩。
// ─────────────────────────────────────────────────────────────────────────────
//
// 口径（② 不做断言 / ② 反转变异**预期绿** / ④ 由 **CP1** 与 **CP2′** 承担 / 偏离裁决的标注）
// 集中在 `test/client.test.mjs` 的文件头「三句口径」一节 —— 那三句是队长终版裁定的逐字留档。
//
// 运行：node --test test/host.test.mjs

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
	apply, Config, API_PREFIX, SERVE_PREFIX, IFRAME_SANDBOX,
	EMBED_VALUE, RUNNER_HEIGHT_MESSAGE_TYPE, runnerMeasureScript, withRunnerMeasure,
	CREATE_MINIAPP_SKILL, CREATE_MINIAPP_SKILL_NAME, CREATE_MINIAPP_DRAFT
} from '../lib/index.js'
import { MiniAppBadRequest } from '../lib/store.js'
import { MINIAPP_TEMPLATES, TEMPLATE_CATEGORIES } from '../lib/templates.js'
import { validateImport } from '../lib/validate.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { loadAsar, extractPackageClosure, describeClosure, skipReason } from './asar-reader.mjs'

const GOOD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>番茄钟</title></head>
<body><main><h1>番茄钟</h1></main></body></html>
`

/**
 * 一个刚好够用的假 ctx。
 *
 * 只实现被 `apply` 真正用到的接口：effect / logger / tools.register /
 * inject / webServer.register / skills.register。刻意不实现别的 —— 任何越界调用都会
 * 立刻炸出来，而不是被一个万能 mock 悄悄吞掉。
 */
function createFakeContext() {
	const registered = { tools: [], routes: [], effects: [], effectDisposers: [], skills: [] }
	const logger = {
		lines: [],
		info(message) { logger.lines.push(['info', message]) },
		warn(message) { logger.lines.push(['warn', message]) },
		error(message) { logger.lines.push(['error', message]) }
	}
	/** 与 `@deepseek-ai/dsh-skill` 逐字同一条：`SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`。 */
	const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
	/** 同 `validateInvocation`：存在就必须是对象、两个开关都必须是 boolean。 */
	const validateInvocation = (invocation, subject) => {
		if (invocation === undefined) return
		if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
			throw new TypeError(`${subject} with a non-object invocation policy`)
		}
		if (typeof invocation.modelInvocable !== 'boolean') throw new TypeError(`${subject} with a non-boolean invocation.modelInvocable`)
		if (typeof invocation.userInvocable !== 'boolean') throw new TypeError(`${subject} with a non-boolean invocation.userInvocable`)
	}

	/**
	 * 忠实照抄 `@deepseek-ai/dsh-skill` 的**四条**性质。
	 *
	 * 前三条是这个替身一开始就有的（名字/description 校验、同层同名先到先得、disposer
	 * 真的摘掉）。第四条是补上的，因为它的缺席让一个 blocker 在 155/155 全绿里溜了过去：
	 *
	 *  1. `register` 只校验 name / description / invocation —— **不校验 source**；
	 *     它补的是 `invocation` 与 `provider`（定义就是 `{...skill, invocation, provider}`）。
	 *  2. `list` 走 `toSummary`：把字段拷一遍放进摘要，**不校验**。所以缺 `source` 的技能
	 *     在目录里照样看得见 —— 客户端拿到的候选、lexicon、`/` 触发器标签全都正常。
	 *  3. `get` 走 `validateDefinition`：name / description / source / provider / content
	 *     必须是 string，缺 `source` **当场抛错**。校验发生在 `get`，不在 `register`。
	 *  4. 真实的那两个消费者：`dsh-tool-skill` 在用户敲 `/name` 之后调 `skills.get(name, …)`
	 *     取正文注入模型上下文；异常会被 agent loop 的裸 `catch` 吞掉。
	 *
	 * 于是替身必须**同时**提供 list 与 get：只做 register 的话，第 1、2 条让一切看起来正常，
	 * 而真正的失败点在第 3 条。假替身比真货宽容，测试就变成了装饰。
	 */
	const skillRegistry = {
		register(skill) {
			if (typeof skill?.name !== 'string' || !SKILL_NAME.test(skill.name)) {
				throw new Error(`invalid skill name "${skill?.name}"`)
			}
			if (typeof skill.description !== 'string' || skill.description.length === 0) {
				throw new Error(`skill "${skill.name}" requires a description`)
			}
			validateInvocation(skill.invocation, `runtime skill "${skill.name}"`)
			if (registered.skills.some((entry) => entry.name === skill.name)) {
				logger.warn(`runtime skill "${skill.name}" ignored because it is already registered`)
				return () => undefined
			}
			// 注册表补的两个字段 —— `source` **不在其中**，这就是 F1 的入口本身。
			const definition = {
				...skill,
				invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
				provider: skill.provider ?? 'runtime'
			}
			registered.skills.push(definition)
			return () => {
				const index = registered.skills.indexOf(definition)
				if (index >= 0) registered.skills.splice(index, 1)
			}
		},
		/** `toSummary` 的等价物：拷字段、不校验（缺 source 时这里**必须**照样成功）。 */
		async list() {
			return registered.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
				invocation: skill.invocation,
				source: skill.source,
				provider: skill.provider
			}))
		},
		/**
		 * `validateDefinition` 的等价物：**必需字段闭集**逐个查类型。
		 *
		 * 字段清单与 `dsh-skill` 的 `validateDefinition` 一一对应（name / description /
		 * whenToUse? / invocation / source / provider / content / path?），顺序也一样，
		 * 这样将来真服务加字段时，两边一起对不上的地方看得见。
		 */
		async get(name) {
			const skill = registered.skills.find((entry) => entry.name === name)
			if (skill === undefined) return undefined
			if (typeof skill.name !== 'string') throw new TypeError('loaded skill name must be a string')
			if (!SKILL_NAME.test(skill.name)) throw new Error(`loaded skill has invalid name "${skill.name}"`)
			if (typeof skill.description !== 'string') throw new TypeError(`loaded skill "${name}" description must be a string`)
			if (skill.description.length === 0) throw new Error(`loaded skill "${name}" requires a description`)
			validateInvocation(skill.invocation, `loaded skill "${name}"`)
			if (skill.whenToUse !== undefined && typeof skill.whenToUse !== 'string') throw new TypeError(`loaded skill "${name}" whenToUse must be a string`)
			if (typeof skill.source !== 'string') throw new TypeError(`loaded skill "${name}" source must be a string`)
			if (typeof skill.provider !== 'string') throw new TypeError(`loaded skill "${name}" provider must be a string`)
			if (typeof skill.content !== 'string') throw new TypeError(`loaded skill "${name}" content must be a string`)
			if (skill.path !== undefined && typeof skill.path !== 'string') throw new TypeError(`loaded skill "${name}" path must be a string`)
			return skill
		}
	}

	const ctx = {
		registered,
		logger,
		effect(fn, label) {
			registered.effects.push(label ?? '(unnamed)')
			const disposer = fn()
			const dispose = typeof disposer === 'function' ? disposer : () => undefined
			registered.effectDisposers.push({ label: label ?? '(unnamed)', dispose })
			return dispose
		},
		tools: {
			register(definition) { registered.tools.push(definition); return () => undefined }
		},
		skills: skillRegistry,
		// 真实 Cordis 会在服务就绪后回调；测试里两个服务都视为已就绪。
		inject(names, callback) { callback(ctx); return () => undefined },
		// 忠实照抄宿主 `dsh-host-webserver` 的 register：**重复路径抛错**，
		// 返回的 disposer **真的把路由摘掉**。这两条性质是"路由注册必须包在 ctx.effect 里"
		// 的全部理由 —— 假替身如果写成"永远吞掉、永远不删"，那条泄漏就永远测不出来。
		webServer: {
			register(route) {
				if (registered.routes.some((r) => r.path === route.path)) {
					throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
				}
				registered.routes.push(route)
				return () => {
					const index = registered.routes.indexOf(route)
					if (index >= 0) registered.routes.splice(index, 1)
				}
			}
		}
	}
	return ctx
}

/** 起一个带临时数据目录的宿主。 */
async function withHost(run) {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-miniapp-host-'))
	try {
		const ctx = createFakeContext()
		apply(ctx, { ...Config({}), dataDir: dir })
		const tools = new Map(ctx.registered.tools.map((definition) => [definition.name, definition]))
		const routeFor = (prefix) => {
			const found = ctx.registered.routes.find((r) => r.path === prefix)
			assert.ok(found, `没有为 ${prefix} 注册路由`)
			return found
		}
		return await run({
			ctx, dir, tools,
			skills: ctx.registered.skills,
			// 两个真实消费通道也要交出去：只给 `skills` 数组的话，测试只能断言
			// "注册被调用"，而缺 source 时那**照样**成立。
			skillRegistry: ctx.skills,
			apiRoute: routeFor(API_PREFIX), serveRoute: routeFor(SERVE_PREFIX), routes: ctx.registered.routes
		})
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

/**
 * 调一个已注册工具，走它声明的校验 + execute。
 *
 * `cwd` 模拟会话工作区：import/validate 只允许读工作区内的文件，不传就等于
 * 「这个会话没有工作区」，应当 fail closed。
 */
async function runTool(tools, name, args, cwd) {
	const definition = tools.get(name)
	assert.ok(definition, `工具 ${name} 没有注册`)
	const exec = {
		signal: new AbortController().signal,
		...(cwd === undefined ? {} : { agent: { session: { header: { cwd } } } })
	}
	return definition.execute(args, exec)
}

/** 构造一个假 req/res 对，打 route.handler。 */
async function httpRequest(route, method, path, body, headers = {}) {
	assert.ok(route, '路由没有注册')
	const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
	const req = Readable.from(payload)
	req.method = method
	req.url = path
	req.headers = Object.assign({ origin: 'http://127.0.0.1:59822' }, headers)

	let status = 0
	let responseHeaders = {}
	let text = ''
	/**
	 * 一个**按 Node 语义**工作的假 res。
	 *
	 * 这一点很要紧：早先的版本把 `removeHeader` 写成了无条件的 `delete`，
	 * 于是「先 writeHead 再 removeHeader」这个会抛 ERR_HTTP_HEADERS_SENT、
	 * 在真实进程里表现为 curl "Empty reply from server" 的写法，在测试里一路绿灯。
	 * 假替身比真货宽容，测试就变成了装饰。
	 */
	const res = {
		headersSent: false,
		headers: {},
		writeHead(nextStatus, nextHeaders) {
			if (res.headersSent) {
				throw Object.assign(new Error('Cannot write headers after they are sent to the client'), {
					code: 'ERR_HTTP_HEADERS_SENT'
				})
			}
			status = nextStatus
			responseHeaders = nextHeaders ?? {}
			res.headersSent = true
		},
		setHeader(name, value) {
			if (res.headersSent) {
				throw Object.assign(new Error('Cannot set headers after they are sent to the client'), {
					code: 'ERR_HTTP_HEADERS_SENT'
				})
			}
			responseHeaders[name.toLowerCase()] = value
		},
		getHeader(name) { return responseHeaders[name.toLowerCase()] },
		removeHeader(name) {
			// Node 的真实行为：响应头一旦发出就不能再改。
			if (res.headersSent) {
				throw Object.assign(new Error('Cannot remove headers after they are sent to the client'), {
					code: 'ERR_HTTP_HEADERS_SENT'
				})
			}
			delete responseHeaders[name.toLowerCase()]
		},
		end(chunk) { text = chunk === undefined ? '' : String(chunk) }
	}
	await route.handler(req, res)
	let json
	try { json = JSON.parse(text) } catch { json = undefined }
	return { status, headers: responseHeaders, text, json }
}

// ------------------------------------------------------------------ 注册面

test('两条路由注册在 ctx.effect 里：卸载摘干净，重新装载不会撞车', async () => {
	// 这条是从代理审计里的 H1 来的：`ctx.webServer.register(...)` 的返回值原来被丢弃，
	// 而宿主的 register **不是** effect（`dsh-host-webserver`: `table.set(...); return () => table.delete(...)`），
	// 所以 fiber 卸载后路由还在，闭包里是**旧 store**；新 fiber 再注册同一路径就抛
	// `duplicate prefix route` —— 重载后的插件起不来，只能重启进程。
	await withHost(async ({ ctx, routes, dir }) => {
		assert.equal(routes.length, 2)

		// 按 Cordis 的语义卸载：逐个跑 effect 的 disposer。
		for (const entry of ctx.registered.effectDisposers) entry.dispose()
		assert.deepEqual(routes, [], 'effect 撤销后路由表必须为空')

		// 重新装载（等价于 HMR / bundle 重载）：不该撞车，路由要回来。
		apply(ctx, { ...Config({}), dataDir: dir })
		assert.equal(routes.length, 2, '重新装载必须能注册成功')
	})
})

test('宿主半边注册嵌入式技能 create-miniapp，且注册在 ctx.effect 里（卸载即撤销）', async () => {
	await withHost(async ({ ctx, skills, dir }) => {
		assert.equal(skills.length, 1, '只该注册一个技能')
		const skill = skills[0]
		assert.equal(skill.name, CREATE_MINIAPP_SKILL.name)
		// 名字逐字等于 `/create-miniapp` 里那个词：DSH 的 `/` 触发器拿草稿里的
		// `/name` 去查当前会话的技能 lexicon，查不到就只是普通文本。
		assert.equal(skill.name, 'create-miniapp')
		assert.ok(skill.description.length > 0, 'DSH 的 register 会拒绝空 description')
		assert.equal(skill.invocation.modelInvocable, false, '这条技能的入口是人，不是模型')
		assert.equal(skill.invocation.userInvocable, true)
		// 正文必须真的带上：`content` 是字符串才进得了模型上下文。
		assert.equal(typeof skill.content, 'string')
		assert.ok(skill.content.length > 400, '正文短得不像一份构建契约')

		// Cordis 卸载 = 逐个跑 effect 的 disposer。技能必须跟着消失：同一个层里
		// 同名运行时注册**先到先得**，留一份旧的在那儿，重装后新的那份会被忽略。
		for (const entry of ctx.registered.effectDisposers) entry.dispose()
		assert.deepEqual(skills, [], 'effect 撤销后技能必须摘掉')
		// 重新装载（HMR / bundle 重载）必须能再注册上。
		apply(ctx, { ...Config({}), dataDir: dir })
		assert.equal(ctx.registered.skills.length, 1, '重新装载必须能再注册上')
	})
})

test('注册的技能对象满足 dsh-skill 的必需字段闭集：list 与 get **两条通道**都要过', async () => {
	await withHost(async ({ skills, skillRegistry }) => {
		const skill = skills[0]
		assert.ok(skill !== undefined, '技能没有被注册')

		// ① 交付对象自己必须带 `source`：注册表只补 `invocation` 与 `provider`。
		//    少了它，注册成功、`list()` 里看得见，而 `get()` 抛 —— 也就是说
		//    "技能在目录里"与"技能能用"是两件事，这条断言钉的是后者。
		assert.equal(typeof CREATE_MINIAPP_SKILL.source, 'string')
		assert.ok(CREATE_MINIAPP_SKILL.source.length > 0, 'source 不能是空串')
		assert.equal(CREATE_MINIAPP_SKILL.provider, undefined, 'provider 是注册表补的，不该由我们写')

		// ② 走**真实消费通道**，而不是只看那个数组。
		//    `list()`：客户端拿候选 / lexicon / `/` 标签走这条。
		const listed = await skillRegistry.list()
		assert.deepEqual(listed.map((entry) => entry.name), ['create-miniapp'])
		//    `get(name, options)`：用户敲 `/create-miniapp` 之后，dsh-tool-skill 就是
		//    用这条取正文注入模型上下文的（dsh-tool-skill 的 pre-step）。
		const full = await skillRegistry.get('create-miniapp')
		assert.ok(full !== undefined, 'get 解析不到定义 ⇒ 正文永远进不了模型上下文，用户侧表现为"发送后什么都没发生"')
		assert.ok(typeof full.content === 'string' && full.content.length > 400)

		// ③ 必需字段闭集：逐字对应 dsh-skill 的 `validateDefinition`（name / description /
		//    whenToUse? / invocation / source / provider / content / path?）。有值、类型对。
		for (const field of ['name', 'description', 'source', 'provider', 'content']) {
			assert.equal(typeof full[field], 'string', `${field} 必须是 string`)
			assert.ok(full[field].length > 0, `${field} 不能是空串`)
		}
		assert.equal(full.provider, 'runtime', '运行时注册的 provider 由注册表补')
		assert.equal(full.source, CREATE_MINIAPP_SKILL.source)
		assert.equal(full.name, 'create-miniapp')
		assert.match(full.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		assert.equal(typeof full.whenToUse, 'string')

		// ④ 反空断言：证明上面 ② 真的在测 `get`，而不是"替身太宽容"。
		//    故意注册一份**缺 source** 的副本：注册必须照样成功、list 必须照样看得见
		//    （真实服务就是这样，这正是 F1 看不见的原因），而 get 必须抛。
		skillRegistry.register({ name: 'no-source', description: '故意缺 source', content: '# x' })
		assert.equal(
			(await skillRegistry.list()).some((entry) => entry.name === 'no-source'),
			true,
			'list 不该校验 source —— 真实服务就是在这里放行的'
		)
		await assert.rejects(
			() => skillRegistry.get('no-source'),
			/source must be a string/,
			'get 必须校验 source，否则这类缺陷在单测里永远不可见'
		)
	})
})

test('技能正文自足，且不含任何"只在这一台机器上成立"的东西', () => {
	const { content } = CREATE_MINIAPP_SKILL

	// 正文里点名的工具必须逐个对得上：写错一个，模型就会去调一个不存在的工具，
	// 而这正是这条技能存在的意义（把人送到能干活的地方）。
	for (const tool of [
		'miniapp_create', 'miniapp_write_source', 'miniapp_read_source',
		'miniapp_iterate', 'miniapp_publish', 'miniapp_validate', 'miniapp_import'
	]) {
		assert.ok(content.includes(tool), `正文没有提到 ${tool}`)
	}
	// 三件必须说清楚的事：自包含单文件、不要构建步骤、写完要提醒去点「发布」。
	assert.ok(content.includes('自包含'))
	assert.ok(content.includes('构建步骤'))
	assert.ok(content.includes('发布'))
	// 别拿 read / write / edit 去撞文件沙箱 —— 工具描述里已经写了，但模型第一轮
	// 最容易犯的就是这个错，正文里再说一遍是有意的重复。
	assert.ok(content.includes('miniapp_read_source'))

	// 技能正文是**逐字进模型上下文**的东西：本机绝对路径、用户名、时间戳
	// 一旦写进去就跟着每一个用户的每一次调用走。
	assert.ok(!/\/Users\/|\/home\/|[A-Za-z]:\\/.test(content), '正文里出现了绝对路径')
	assert.ok(!content.includes(homedir()), '正文里出现了当前用户的家目录')
	assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(content), '正文里出现了时间戳')

	// 三个元数据字段都不能空：DSH 的 register 在 name / description 上会当场抛错。
	assert.ok(CREATE_MINIAPP_SKILL.description.length > 0)
	assert.ok(CREATE_MINIAPP_SKILL.whenToUse.length > 0)
	assert.deepEqual({ ...CREATE_MINIAPP_SKILL.invocation }, { modelInvocable: false, userInvocable: true })
	// 常量冻结：别的代码不该顺手改掉一份要给模型看的文本。
	assert.ok(Object.isFrozen(CREATE_MINIAPP_SKILL))

	// 客户端预置进输入框的那句话与技能名同源：尾部那个空格不是手滑 —— DSH 判定
	// `/name` 成词的边界是 `/^(?:\s|$)/`，带上它光标落在名字之后，用户接着打字
	// 是"补充这句话"，而不是把标签接成一个别的词。
	assert.equal(CREATE_MINIAPP_DRAFT, `/${CREATE_MINIAPP_SKILL_NAME} `)
	assert.equal(CREATE_MINIAPP_DRAFT, '/create-miniapp ')
})

test('apply 注册了全部工具与路由，且没有 effect 泄漏', async () => {
	await withHost(async ({ ctx, tools, routes, apiRoute, serveRoute }) => {
		assert.deepEqual([...tools.keys()].sort(), [
			'miniapp_create',
			'miniapp_delete',
			'miniapp_get',
			'miniapp_import',
			'miniapp_iterate',
			'miniapp_list',
			'miniapp_publish',
			'miniapp_read_source',
			'miniapp_validate',
			'miniapp_write_source'
		])
		// 两条窄前缀，而不是一条 `/plugins/dsh-miniapp`：不占满
		// `/plugins/<包名>/` 这个宿主已经在自己说话的命名空间。
		assert.equal(routes.length, 2)
		for (const route of [apiRoute, serveRoute]) {
			assert.equal(route.kind, 'prefix')
			assert.equal(typeof route.handler, 'function')
		}
		assert.equal(apiRoute.path, API_PREFIX)
		assert.equal(serveRoute.path, SERVE_PREFIX)
		assert.ok(
			!routes.some((r) => r.path === '/plugins/dsh-miniapp'),
			'不得占用整个 /plugins/<包名> 命名空间'
		)
		// 两条前缀互不重叠：一条请求只可能落进一个 handler。
		assert.ok(!API_PREFIX.startsWith(`${SERVE_PREFIX}/`) && !SERVE_PREFIX.startsWith(`${API_PREFIX}/`))
		assert.ok(ctx.logger.lines.some(([level]) => level === 'info'))
		assert.ok(!ctx.logger.lines.some(([level]) => level === 'error'), '注册期不该有错误')
	})
})

test('每个工具都声明了合法的参数与输出 schema', async () => {
	await withHost(async ({ tools }) => {
		for (const [name, definition] of tools) {
			assert.equal(definition.name, name)
			assert.equal(typeof definition.description, 'string')
			assert.ok(definition.description.length > 0, `${name} 缺描述`)
			assert.equal(definition.parameters.type, 'object', `${name} 的参数 schema 不是 object`)
			assert.equal(typeof definition.output.schema, 'object', `${name} 缺输出 schema`)
			assert.equal(typeof definition.output.render, 'function', `${name} 缺 render`)
			// 声明为 required 的参数必须在 properties 里真实存在。
			for (const key of definition.parameters.required ?? []) {
				assert.ok(definition.parameters.properties[key], `${name}.${key} 声明为必填却不在 properties 里`)
			}
		}
	})
})

// -------------------------------------------------------------- 工具端到端

test('miniapp_create → iterate → publish 全流程', async () => {
	await withHost(async ({ tools }) => {
		const created = await runTool(tools, 'miniapp_create', { name: '番茄钟', icon: '🍅', description: '带提醒的番茄钟' })
		assert.ok(created.miniapp_id)
		assert.equal(created.name, '番茄钟')
		assert.ok(created.source_path.endsWith('working.html'))
		assert.match(created.contract, /自包含/, '必须把构建契约交给模型')

		// 列表里能看到，且还没发布。
		const listed = await runTool(tools, 'miniapp_list', {})
		assert.equal(listed.total, 1)
		assert.equal(listed.apps[0].published_at, null)
		assert.equal(listed.apps[0].has_unpublished_changes, false, '空骨架不该报未发布改动')

		// agent 往工作副本里写内容（这里用 fs 直接模拟它）。
		await writeFile(created.source_path, GOOD_HTML, 'utf8')

		// 迭代入口幂等，返回同一个绝对路径。
		const iterated = await runTool(tools, 'miniapp_iterate', { miniapp_id: created.miniapp_id })
		assert.equal(iterated.source_path, created.source_path)

		// 改过之后标记要亮。
		const beforePublish = await runTool(tools, 'miniapp_get', { miniapp_id: created.miniapp_id })
		assert.equal(beforePublish.has_unpublished_changes, true)

		// 发布之后标记灭，且响应不含正文。
		const published = await runTool(tools, 'miniapp_publish', { miniapp_id: created.miniapp_id })
		assert.equal(published.has_unpublished_changes, false)
		assert.equal(published.html_size, Buffer.byteLength(GOOD_HTML, 'utf8'))
		assert.ok(!('html' in published), '响应不得携带 HTML 正文')
	})
})

test('miniapp_publish 拒绝非文档内容，并保住线上版本', async () => {
	await withHost(async ({ tools }) => {
		const created = await runTool(tools, 'miniapp_create', { name: '番茄钟' })
		await writeFile(created.source_path, GOOD_HTML, 'utf8')
		await runTool(tools, 'miniapp_publish', { miniapp_id: created.miniapp_id })

		// 一轮写坏：把计划稿写进了工作副本。
		await writeFile(created.source_path, 'TODO: 先想清楚时区', 'utf8')
		await assert.rejects(
			() => runTool(tools, 'miniapp_publish', { miniapp_id: created.miniapp_id }),
			/HTML/
		)
	})
})

test('miniapp_delete 之后查不到', async () => {
	await withHost(async ({ tools }) => {
		const created = await runTool(tools, 'miniapp_create', { name: '待删' })
		const removed = await runTool(tools, 'miniapp_delete', { miniapp_id: created.miniapp_id })
		assert.equal(removed.deleted, true)
		assert.equal((await runTool(tools, 'miniapp_list', {})).total, 0)
		await assert.rejects(() => runTool(tools, 'miniapp_get', { miniapp_id: created.miniapp_id }))
	})
})

test('miniapp_validate 与 miniapp_import 走同一套规则', async () => {
	await withHost(async ({ tools, dir }) => {
		const cleanPath = join(dir, 'clean.html')
		await writeFile(cleanPath, GOOD_HTML, 'utf8')
		const clean = await runTool(tools, 'miniapp_validate', { path: cleanPath }, dir)
		assert.equal(clean.blocked, false)
		assert.deepEqual(clean.findings, [])

		const dirtyPath = join(dir, 'dirty.html')
		await writeFile(dirtyPath, '<html><body><img src="./logo.png"></body></html>', 'utf8')
		const dirty = await runTool(tools, 'miniapp_validate', { path: dirtyPath }, dir)
		assert.equal(dirty.blocked, true)
		await assert.rejects(() => runTool(tools, 'miniapp_import', { path: dirtyPath }, dir), /local_ref_unsupported/)

		// 片段可以被导入：自动补成完整文档。
		const fragmentPath = join(dir, 'frag.html')
		await writeFile(fragmentPath, '<div>就一段片段</div>', 'utf8')
		const imported = await runTool(tools, 'miniapp_import', { path: fragmentPath }, dir)
		assert.deepEqual(imported.applied_fixes, ['fragment_not_document'])
		assert.equal(imported.name, 'frag', '没有 title 时按文件名命名')
	})
})

test('miniapp_import 按 <title> 命名，并按码点截断超长标题', async () => {
	await withHost(async ({ tools, dir }) => {
		const titled = join(dir, 'a.html')
		await writeFile(titled, '<html><head><title>  我的工具  </title></head><body></body></html>', 'utf8')
		assert.equal((await runTool(tools, 'miniapp_import', { path: titled }, dir)).name, '我的工具')

		const longTitled = join(dir, 'b.html')
		await writeFile(longTitled, `<html><head><title>${'番'.repeat(150)}</title></head><body></body></html>`, 'utf8')
		// 用户被告知会导入就不能在最后一步被拒：截断而不是报错。
		assert.equal(Array.from((await runTool(tools, 'miniapp_import', { path: longTitled }, dir)).name).length, 100)
	})
})

test('每个工具的返回值都必须通过它自己声明的 output schema', async () => {
	// DSH 在真实进程里**强制**这一点：`additionalProperties: false` 的输出 schema
	// 遇到一个多出来的字段，整个工具调用会以
	// 「tool "x" returned invalid output: "value.y" is not a declared property」
	// 失败。2026-09 的一次 headless 实跑就是这样抓到 `source_session_id` 缺失的；
	// 把校验搬进测试，才能在下一次改动里立刻发现，而不是等真实进程报错。
	await withHost(async ({ tools, dir }) => {
		const htmlPath = join(dir, 'x.html')
		await writeFile(htmlPath, GOOD_HTML, 'utf8')

		const created = await runTool(tools, 'miniapp_create', { name: '番茄钟', html: GOOD_HTML })
		await writeFile(created.source_path, GOOD_HTML, 'utf8')

		const cases = [
			['miniapp_create', created],
			['miniapp_list', await runTool(tools, 'miniapp_list', {})],
			['miniapp_get', await runTool(tools, 'miniapp_get', { miniapp_id: created.miniapp_id })],
			['miniapp_iterate', await runTool(tools, 'miniapp_iterate', { miniapp_id: created.miniapp_id })],
			['miniapp_publish', await runTool(tools, 'miniapp_publish', { miniapp_id: created.miniapp_id })],
			['miniapp_validate', await runTool(tools, 'miniapp_validate', { path: htmlPath }, dir)],
			['miniapp_import', await runTool(tools, 'miniapp_import', { path: htmlPath }, dir)],
			['miniapp_delete', await runTool(tools, 'miniapp_delete', { miniapp_id: created.miniapp_id })]
		]

		for (const [name, value] of cases) {
			const definition = tools.get(name)
			const violations = validateJsonSchemaValue(definition.output.schema, value, 'value')
			assert.deepEqual(
				violations,
				[],
				`${name} 的返回值不符合声明的 output schema：${JSON.stringify(violations)}`
			)
		}
	})
})

test('render 是纯函数：同样输入两次调用给出同样内容', async () => {
	await withHost(async ({ tools }) => {
		const created = await runTool(tools, 'miniapp_create', { name: '番茄钟', html: GOOD_HTML })
		const listed = await runTool(tools, 'miniapp_list', {})
		for (const [name, args, value] of [
			['miniapp_create', { name: '番茄钟', html: GOOD_HTML }, created],
			['miniapp_list', {}, listed]
		]) {
			const definition = tools.get(name)
			const first = definition.output.render(args, value)
			const second = definition.output.render(args, value)
			assert.deepEqual(first, second, `${name}.render 不是纯函数`)
			assert.ok(Array.isArray(first) && first.length > 0, `${name}.render 必须返回内容块`)
			assert.equal(first[0].type, 'text')
			assert.equal(typeof first[0].text, 'string')
		}
	})
})

test('miniapp_read_source / miniapp_write_source 是迭代的唯一通道', async () => {
	// 这条工作流存在的原因是一个真实的失败：工作副本在会话工作区之外，
	// `workspace-write` 沙箱会拒绝直接 write/read 它。工具成了唯一的入口，
	// 而它们只接受 miniapp_id —— 路径由插件自己派生，所以不构成沙箱逃逸。
	await withHost(async ({ tools }) => {
		const created = await runTool(tools, 'miniapp_create', { name: '番茄钟' })

		// 刚建时工作副本是空的。
		const empty = await runTool(tools, 'miniapp_read_source', { miniapp_id: created.miniapp_id })
		assert.equal(empty.html, '')
		assert.equal(empty.bytes, 0)
		assert.equal(empty.has_unpublished_changes, false)

		// 写第一版。
		const written = await runTool(tools, 'miniapp_write_source', {
			miniapp_id: created.miniapp_id,
			html: GOOD_HTML
		})
		assert.equal(written.bytes, Buffer.byteLength(GOOD_HTML, 'utf8'))
		assert.equal(written.needs_publish, true, '写完必须提醒用户发布')

		// 读回来是同一份，且未发布标记亮了。
		const readBack = await runTool(tools, 'miniapp_read_source', { miniapp_id: created.miniapp_id })
		assert.equal(readBack.html, GOOD_HTML)
		assert.equal(readBack.has_unpublished_changes, true)

		// 写是整份替换，不是追加。
		const v2 = GOOD_HTML.replace('番茄钟', '番茄钟 v2')
		await runTool(tools, 'miniapp_write_source', { miniapp_id: created.miniapp_id, html: v2 })
		assert.equal((await runTool(tools, 'miniapp_read_source', { miniapp_id: created.miniapp_id })).html, v2)

		// 发布后标记灭。
		await runTool(tools, 'miniapp_publish', { miniapp_id: created.miniapp_id })
		assert.equal((await runTool(tools, 'miniapp_read_source', { miniapp_id: created.miniapp_id })).has_unpublished_changes, false)
	})
})

test('miniapp_write_source 做基础校验，但把文档形状留给 publish', async () => {
	await withHost(async ({ tools }) => {
		const created = await runTool(tools, 'miniapp_create', { name: '番茄钟' })
		// 空与超限当场拒绝。
		await assert.rejects(() => runTool(tools, 'miniapp_write_source', { miniapp_id: created.miniapp_id, html: '   ' }), /不能为空/)
		await assert.rejects(
			() => runTool(tools, 'miniapp_write_source', { miniapp_id: created.miniapp_id, html: 'x'.repeat(4 * 1024 * 1024 + 1) }),
			/上限/
		)
		// 但「是一份完整网页」不在这里判：迭代过程中允许中间态，
		// 真正绝不能上线半个文档的是 publish。
		await runTool(tools, 'miniapp_write_source', { miniapp_id: created.miniapp_id, html: '写了一半' })
		await assert.rejects(() => runTool(tools, 'miniapp_publish', { miniapp_id: created.miniapp_id }), /HTML/)
	})
})

test('工作区守卫必须解析符号链接：symlink 不能把工作区外的文件搬进来', async () => {
	// 词法前缀判断（`resolve()` + `startsWith`）挡不住符号链接：工作区里一个
	// `innocent.html -> /tmp/secret.html` 就能让守卫放行，把工作区外的文档读进库、
	// 再经 `read_source` 回给模型 —— 而这段守卫的全部意义就是阻止这件事
	// （工具跑在宿主里，不受会话文件沙箱约束）。两个代理各自独立复现过。
	await withHost(async ({ ctx, tools }) => {
		const root = await mkdtemp(join(tmpdir(), 'dsh-miniapp-ws-'))
		const outside = await mkdtemp(join(tmpdir(), 'dsh-miniapp-out-'))
		try {
			const ws = join(root, 'workspace')
			await mkdir(ws, { recursive: true })
			await writeFile(join(outside, 'secret.html'), '<html><body>TOP-SECRET</body></html>')
			await writeFile(join(ws, 'ok.html'), '<html><body>inside</body></html>')
			await symlink(join(outside, 'secret.html'), join(ws, 'file-link.html'))
			await symlink(outside, join(ws, 'dir-link'))

			const exec = { agent: { session: { header: { cwd: ws } } } }
			const validate = tools.get('miniapp_validate')

			// 工作区内的真文件：照常放行（守卫不能把正常用法也挡掉）。
			const inside = await validate.execute({ path: join(ws, 'ok.html') }, exec)
			assert.equal(inside.blocked, false)

			// 三种逃逸都必须被拒。
			for (const candidate of [
				join(ws, 'file-link.html'),
				join(ws, 'dir-link', 'secret.html'),
				join(outside, 'secret.html')
			]) {
				await assert.rejects(
					() => validate.execute({ path: candidate }, exec),
					(err) => err instanceof MiniAppBadRequest,
					`必须拒绝 ${candidate}`
				)
			}

			// 前缀相近的兄弟目录也不能混进来（`/ws-evil` 不该被当成 `/ws` 之内）。
			await assert.rejects(
				() => validate.execute({ path: `${ws}-evil/x.html` }, exec),
				(err) => err instanceof MiniAppBadRequest
			)
		} finally {
			await rm(root, { recursive: true, force: true })
			await rm(outside, { recursive: true, force: true })
		}
	})
})

test('导入来源被限制在会话工作区内，工作区外一律拒绝', async () => {
	await withHost(async ({ tools, dir }) => {
		const outside = join(dir, '..', `outside-${Date.now()}.html`)
		await writeFile(outside, GOOD_HTML, 'utf8')
		try {
			// 路径存在、内容合法，但它不在会话工作区里。
			await assert.rejects(() => runTool(tools, 'miniapp_validate', { path: outside }, dir), /不在/)
			await assert.rejects(() => runTool(tools, 'miniapp_import', { path: outside }, dir), /不在/)
			// 没有工作区的会话 fail closed，而不是放行。
			await assert.rejects(() => runTool(tools, 'miniapp_validate', { path: outside }), /工作区/)
			// 相对路径也不接受。
			await assert.rejects(() => runTool(tools, 'miniapp_validate', { path: 'x.html' }, dir), /绝对路径/)
		} finally {
			await rm(outside, { force: true })
		}
	})
})

// -------------------------------------------------------------- HTTP 端到端

test('库 API：创建 → 列表 → 改名 → 发布 → 删除', async () => {
	await withHost(async ({ tools, apiRoute, serveRoute }) => {
		const created = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/apps`, { name: '番茄钟', icon: '🍅' })
		assert.equal(created.status, 200)
		assert.equal(created.json.ok, true)
		const id = created.json.data.miniapp_id
		assert.ok(id)

		const listed = await httpRequest(apiRoute, 'GET', `${API_PREFIX}/apps`)
		assert.equal(listed.json.data.length, 1)
		assert.equal(listed.json.data[0].name, '番茄钟')

		// agent 写入内容后发布。
		const created2 = await runTool(tools, 'miniapp_create', { name: '第二个', html: GOOD_HTML })
		const published = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/apps/${created2.miniapp_id}/publish`)
		assert.equal(published.status, 200)
		assert.equal(published.json.data.has_unpublished_changes, false)

		const renamed = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/apps/${id}`, { name: '番茄钟 2' })
		assert.equal(renamed.json.data.name, '番茄钟 2')

		const removed = await httpRequest(apiRoute, 'DELETE', `${API_PREFIX}/apps/${id}`)
		assert.equal(removed.status, 200)
		assert.equal(removed.json.data.deleted, true)
		assert.equal((await httpRequest(apiRoute, 'GET', `${API_PREFIX}/apps`)).json.data.length, 1)
	})
})

test('直出通道：正文逐字节、带上沙箱 CSP、没有 X-Frame-Options', async () => {
	await withHost(async ({ tools, apiRoute, serveRoute }) => {
		const app = await runTool(tools, 'miniapp_create', { name: '番茄钟', html: GOOD_HTML })
		const served = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/${app.miniapp_id}`)

		assert.equal(served.status, 200)
		assert.equal(served.headers['content-type'], 'text/html; charset=utf-8')
		assert.equal(served.headers['cache-control'], 'private, no-cache')
		assert.equal(served.headers['x-content-type-options'], 'nosniff')
		assert.equal(served.text, GOOD_HTML, '必须逐字节直出')
		// 沙箱策略写在响应头上，而不只写在 iframe 属性上 —— 直接导航也必须被沙箱。
		const csp = served.headers['content-security-policy']
		assert.match(csp, /sandbox allow-scripts allow-forms allow-popups allow-modals/)
		assert.match(csp, /frame-ancestors 'self'/)
		assert.ok(!csp.includes('allow-same-origin'), 'allow-same-origin 会取消沙箱')
		assert.equal(served.headers['x-frame-options'], undefined, '不能带 X-Frame-Options，否则框不出来')
	})
})

test('未发布的小程序在直出通道上是干净的 404，绝不是 401/403', async () => {
	await withHost(async ({ tools, apiRoute, serveRoute }) => {
		const draft = await runTool(tools, 'miniapp_create', { name: '草稿' })
		const served = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/${draft.miniapp_id}`)
		// 401/403 会暴露「路由存在但被守着」，正是 capability-URL 设计要避免的。
		assert.equal(served.status, 404)

		// **404 的响应体必须是一条文档，不是一段数据。** 这条通道的消费者是浏览器的**文档视图**
		// （iframe 里的预览，或者直接导航过去），而 `application/json` 即使带 `nosniff` 也会被
		// 内联渲染成纯文本 —— 实测过一次：用户在预览区看到的是 `{"ok":false,…}` 那段花括号。
		// 所以缺口要用文档说，而且状态码仍然是 404（不是 200，也不是 401/403）。
		assert.equal(served.headers['content-type'], 'text/html; charset=utf-8',
			'未发布的直出必须是 HTML 文档，不能是 JSON')
		assert.match(served.text, /^\s*<!DOCTYPE html>/i, '响应体要是一份完整的 HTML 文档')
		assert.equal(served.text.trimStart().startsWith('{'), false, '绝不能是 JSON 那种数据形状')
		assert.equal(served.headers['cache-control'], 'no-store', '缺口没有可缓存的内容')
		assert.equal(served.headers['x-content-type-options'], 'nosniff')

		// 不存在的 id 走同一条缺口分支：**同一个表达** —— 否则"没发布"与"没有这个"会长得不一样，
		// 而这两种情形的区别我们本来就无意泄漏。
		const unknown = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/0190f5fe-7c00-7000-8000-000000000001`)
		assert.equal(unknown.status, 404)
		assert.equal(unknown.headers['content-type'], 'text/html; charset=utf-8')
		assert.match(unknown.text, /^\s*<!DOCTYPE html>/i)

		const malformed = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/not-an-id`)
		assert.equal(malformed.status, 400)
	})
})

test('直出通道不需要 Origin（iframe 子资源请求不带信任头）', async () => {
	await withHost(async ({ tools, apiRoute, serveRoute }) => {
		const app = await runTool(tools, 'miniapp_create', { name: '番茄钟', html: GOOD_HTML })
		const served = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/${app.miniapp_id}`, undefined, { origin: undefined })
		assert.equal(served.status, 200, '缺少 Origin 时直出通道仍须可达')
	})
})

test('写接口要求同源 Origin，跨站页面驱动不了这个 API', async () => {
	await withHost(async ({ apiRoute }) => {
		const crossSite = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/apps`, { name: 'evil' }, { origin: 'https://evil.example' })
		assert.equal(crossSite.status, 403)

		const noOrigin = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/apps`, { name: 'x' }, { origin: undefined })
		assert.equal(noOrigin.status, 403, '写接口必须要求 Origin 存在')

		const loopback = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/apps`, { name: 'ok' }, { origin: 'http://localhost:59822' })
		assert.equal(loopback.status, 200)
	})
})

test('校验接口回报告，导入接口对 blocked 的候选返回 400 且带完整报告', async () => {
	await withHost(async ({ apiRoute }) => {
		const clean = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/validate`, { html: GOOD_HTML })
		assert.equal(clean.status, 200)
		assert.equal(clean.json.data.blocked, false)

		const blocked = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/import`, {
			html: '<html><body><img src="./a.png"></body></html>'
		})
		assert.equal(blocked.status, 400, 'blocked 候选必须是 400')
		// 但报告要完整送达 —— 只给一个状态码会让调用方问第二次。
		assert.equal(blocked.json.data.report.blocked, true)
		assert.ok(blocked.json.data.report.findings.some((f) => f.rule_id === 'local_ref_unsupported'))
	})
})

test('两条 URL 前缀是**字面量**里的那两个：不是"自己等于自己"', () => {
	// 变异审计的 M15/N04：把 `API_PREFIX` 或 `SERVE_PREFIX` 的值改掉，套件全绿 ——
	// 因为原来的断言是 `assert.equal(apiRoute.path, API_PREFIX)`，两边同源，改一起改。
	// 而这两个前缀是**对外契约**（README 里写着、客户端的 fetch 与 iframe src 用的是
	// 同一份字符串的副本），漂移了不会有任何东西报警。
	assert.equal(API_PREFIX, '/plugins/dsh-miniapp/api')
	assert.equal(SERVE_PREFIX, '/plugins/dsh-miniapp/serve')
})

test('片段候选在导入时被自动包成文档', async () => {
	await withHost(async ({ apiRoute, serveRoute }) => {
		const imported = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/import`, { html: '<div>片段</div>', name: '片段应用' })
		assert.equal(imported.status, 200)
		assert.deepEqual(imported.json.data.applied_fixes, ['fragment_not_document'])
		assert.equal(imported.json.data.app.name, '片段应用')
		// 落库的是包装后的文档，不是原始片段。
		const served = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/${imported.json.data.app.miniapp_id}`)
		assert.match(served.text, /<!DOCTYPE html>/)
		assert.match(served.text, /<div>片段<\/div>/)
	})
})

// ------------------------------------------------------- 嵌入模式（?embed=1）
//
// 会话右上角的浮窗要"默认自适应高度"，而浮窗 iframe 的沙箱串里没有
// `allow-same-origin`：父页面读不到它的 contentDocument。唯一的路是让**文档自己**
// 把高度 postMessage 出来 —— 也就是这里这条直出通道上的 `?embed=1`。
//
// 这条参数是本通道上唯一允许改变正文的东西，所以下面两条测试是它的两条边界：
// 带参数时只多一段量高脚本；不带参数时正文与磁盘上的快照**逐字节相同**。

test('量高脚本只量高度：不读内容、不碰网络、不写存储，且插在 </body> 之前', () => {
	const script = runnerMeasureScript()

	// 1. 三件事：量高度、postMessage、变化时重发。
	assert.ok(script.startsWith('<script>'), '要是一段能直接拼进文档的 <script>')
	assert.ok(script.endsWith('</script>'))
	assert.ok(script.includes('document.documentElement'), '要量 documentElement')
	assert.ok(script.includes('document.body'), '也要量 body（页面可能把高度给其中任一个）')
	assert.ok(script.includes('Math.max('), '取两者的较大值')
	assert.ok(script.includes('parent.postMessage('), '只能通过 postMessage 往外说话')
	assert.ok(
		script.includes(`var TYPE=${JSON.stringify(RUNNER_HEIGHT_MESSAGE_TYPE)};`),
		'消息类型来自那个常量（客户端半边用同一个名字认领，两边漂移就是静默失效）'
	)
	assert.equal(RUNNER_HEIGHT_MESSAGE_TYPE, 'dsh-miniapp:runner-height')
	// 与模板预览那套协议**必须不同名**：message 事件是整页共享的，同名就会互相认领。
	assert.notEqual(RUNNER_HEIGHT_MESSAGE_TYPE, 'dsh-miniapp:preview-height')
	assert.ok(script.includes('"*"'), 'targetOrigin 必须是 "*"：不透明源的 origin 是字符串 "null"')
	assert.ok(script.includes('ResizeObserver'), '优先用 ResizeObserver（内容自己长高也能抓住）')
	assert.ok(script.includes('window.addEventListener("resize"'), '没有它时退到 window.resize')
	assert.ok(script.includes('window.addEventListener("load"'), '字体/图片迟到会让高度变，load 之后再量一次')

	// 2. 它**只是**一段量高脚本：这些能力一个都不能碰。
	for (const forbidden of ['document.write', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch(', 'XMLHttpRequest', 'document.cookie', 'innerHTML']) {
		assert.equal(script.includes(forbidden), false, `量高脚本不该碰 ${forbidden}`)
	}
})

test('量高脚本必须是一段**能被解析**的 JS，而且要真的能量出高度', () => {
	// 变异审计的 X01：把 `parent.postMessage({type:TYPE,height:height},"*");` 里少写一个逗号
	// （语法错误）之后，套件仍然 116 全绿 —— 因为原来的断言全是 `script.includes("…")`
	// 字符串匹配。一段语法错误的脚本会静默废掉整个"自适应高度"，浮窗只会退回兜底尺寸。
	// 所以这里必须**真的解析**它，并且在一个假的文档/postMessage 环境里**真的跑一次**。
	const script = runnerMeasureScript()
	// 它是一段**带标签的** <script> 片段（要直接拼进文档），所以先剥标签再解析。
	assert.match(script, /^<script>[\s\S]*<\/script>$/, '脚本必须是完整的一对 <script> 标签')
	const js = script.replace(/^<script>/, '').replace(/<\/script>$/, '')
	assert.doesNotThrow(() => new Function(js), '量高脚本里的 JS 必须是合法的')

	// 真跑：给一段最小的假 DOM，看它发回来的到底是不是我们要的那条消息。
	const sent = []
	const listeners = []
	const doc = {
		documentElement: { scrollHeight: 321 },
		body: { scrollHeight: 654 },
		addEventListener(name, fn) { listeners.push(name) }
	}
	const run = new Function('window', 'document', 'parent', 'ResizeObserver', js)
	run(
		{ innerHeight: 957, addEventListener() {} },
		doc,
		{ postMessage: (message, target) => sent.push([message, target]) },
		undefined
	)
	assert.equal(sent.length, 1, '跑一次就该发一条消息')
	assert.equal(sent[0][0].type, RUNNER_HEIGHT_MESSAGE_TYPE, '消息类型必须与客户端认领的那个逐字一致')
	assert.equal(sent[0][0].height, 654, '取 documentElement/body 的较大值')
	assert.equal(sent[0][1], '*', '沙箱里 origin 是 "null"，只能发 "*"')
})

test('量高脚本的插入点：</body> 优先，其次 </html>，都没有就追加；大小写不敏感', () => {
	const script = runnerMeasureScript()
	const before = (html) => withRunnerMeasure(html, script)

	// 1. </body> 之前。
	const upper = before('<html><body><b>x</b></body></html>')
	assert.equal(upper, `<html><body><b>x</b>${script}</body></html>`)
	// 2. 大小写不敏感：文档完全可能写 `</BODY>`。
	const shouty = before('<HTML><BODY>x</BODY></HTML>')
	assert.equal(shouty, `<HTML><BODY>x${script}</BODY></HTML>`)
	// 3. 没有 </body> 就插在 </html> 之前。
	assert.equal(before('<html><p>x</p></html>'), `<html><p>x</p>${script}</html>`)
	// 4. 两者都没有（片段、或者干脆没闭合）就追加到末尾。
	assert.equal(before('<p>x</p>'), `<p>x</p>${script}`)
	// 5. 空 / 非字符串原样返回：不往一份"没有文档"的响应里塞东西。
	assert.equal(before(''), '')
	assert.equal(before(null), null)
	assert.equal(before(undefined), undefined)
	// 6. 原文一个字节都不丢（只多了一段脚本）。
	const original = GOOD_HTML
	assert.equal(withRunnerMeasure(original, script).replace(script, ''), original)
})

test('直出通道：不带 embed 时正文与磁盘上的快照逐字节相同、响应头一个字节都不变', async () => {
	await withHost(async ({ tools, dir, serveRoute }) => {
		const app = await runTool(tools, 'miniapp_create', { name: '番茄钟', html: GOOD_HTML })
		const plain = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/${app.miniapp_id}`)
		// 快照在磁盘上的原文（路径规则见 lib/store.js 的 snapshotPath）。
		const onDisk = await readFile(join(dir, 'snapshots', `${app.miniapp_id}.html`), 'utf8')

		assert.equal(plain.text, onDisk, '不注入、不改写、不规范化：直出的就是发布的那份文档')
		assert.equal(plain.text, GOOD_HTML)
		assert.equal(plain.text.includes('postMessage'), false, '不带参数时正文里不该出现量高脚本')

		// 各种"看起来像但并不是"的取值一律按不带参数处理 —— 只有逐字 equals "1" 才算数。
		for (const query of ['?embed=0', '?embed=true', '?embed=', '?embed=2', '?other=1', '?embed', '?embed=1&embed=0']) {
			const served = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/${app.miniapp_id}${query}`)
			assert.equal(served.text, GOOD_HTML, `${query} 不该被当成 embed`)
		}

		// ---- 带参数：正文里多出**且只多出**那一段量高脚本。
		const embedded = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/${app.miniapp_id}?embed=${EMBED_VALUE}`)
		assert.equal(embedded.status, 200)
		assert.equal(embedded.text, withRunnerMeasure(onDisk, runnerMeasureScript()))
		assert.equal(embedded.text, withRunnerMeasure(GOOD_HTML, runnerMeasureScript()))
		assert.equal(embedded.text.replace(runnerMeasureScript(), ''), onDisk, '除了那一段脚本，正文逐字节不变')
		// 插在 </body> 之前：脚本运行时 body 已经在，量出来的高度才是真的。
		assert.ok(embedded.text.indexOf(runnerMeasureScript()) < embedded.text.indexOf('</body>'))

		// ---- 响应头：两种模式**完全一致**。CSP 的 sandbox 指令尤其不能动 ——
		// 量高脚本靠的是本来就有的 allow-scripts（小程序本身就是脚本），
		// 不需要、也绝不允许 `allow-same-origin`。
		for (const key of ['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy', 'x-frame-options']) {
			assert.deepEqual(embedded.headers[key], plain.headers[key], `${key} 不该随 embed 变化`)
		}
		const csp = embedded.headers['content-security-policy']
		assert.equal(csp, `sandbox ${IFRAME_SANDBOX}; frame-ancestors 'self'`)
		assert.ok(!csp.includes('allow-same-origin'), 'allow-same-origin 会取消沙箱，绝不允许')

		// 未发布的仍然是干净的 404（带参数也一样）。
		const draft = await runTool(tools, 'miniapp_create', { name: '草稿' })
		const missing = await httpRequest(serveRoute, 'GET', `${SERVE_PREFIX}/${draft.miniapp_id}?embed=${EMBED_VALUE}`)
		assert.equal(missing.status, 404)
	})
})

test('非法与未知路径都被挡住', async () => {
	await withHost(async ({ apiRoute, serveRoute }) => {
		assert.equal((await httpRequest(apiRoute, 'GET', `${API_PREFIX}/apps/not-an-id`)).status, 400)
		assert.equal((await httpRequest(apiRoute, 'GET', `${API_PREFIX}/nope`)).status, 404)
		assert.equal((await httpRequest(apiRoute, 'PUT', `${API_PREFIX}/apps`)).status, 405)
		assert.equal((await httpRequest(serveRoute, 'DELETE', `${SERVE_PREFIX}/x`)).status, 405)
		const health = await httpRequest(apiRoute, 'GET', `${API_PREFIX}/health`)
		assert.equal(health.status, 200)
		assert.equal(health.json.ok, true)
		// 读端点不带 Origin 也放行（本地进程本来就能读盘），而绝对路径没有任何理由
		// 交给每一个能连上这个端口的调用方 —— 所以 /health 只回一个 ok。
		assert.equal(health.json.data.dataDir, undefined, '/health 不许泄漏绝对路径')
		// 方法不允许要 405，而不是把 HEAD/POST 也当 GET 处理。
		assert.equal((await httpRequest(apiRoute, 'POST', `${API_PREFIX}/health`)).status, 405)
	})
})

test('/prefs：读默认值、写后读得到、坏文件不崩也不影响其它端点', async () => {
	// 固定状态是"用户的意图"，重载页面不该丢；客户端没有可靠的持久化 API
	// （localStorage 不是 DSH 的插件契约），所以走宿主。
	await withHost(async ({ apiRoute, dir }) => {
		const read = () => httpRequest(apiRoute, 'GET', `${API_PREFIX}/prefs`)
		const write = (body) => httpRequest(apiRoute, 'POST', `${API_PREFIX}/prefs`, body)

		// 1) 没写过：默认是"没有固定"，而不是 404。
		assert.equal((await read()).json.data.pinned_app_id, null)

		// 2) 写一个合法 id，读回来是它。
		const app = (await httpRequest(apiRoute, 'POST', `${API_PREFIX}/apps`, {
			name: '被固定的', html: '<!doctype html><html><body>x</body></html>'
		})).json.data
		assert.equal((await write({ pinned_app_id: app.miniapp_id })).json.data.pinned_app_id, app.miniapp_id)
		assert.equal((await read()).json.data.pinned_app_id, app.miniapp_id)

		// 3) 取消固定。
		assert.equal((await write({ pinned_app_id: null })).json.data.pinned_app_id, null)

		// 4) 形状不对的值一律归成 null，别把垃圾写进盘里。
		assert.equal((await write({ pinned_app_id: '../../etc/passwd' })).json.data.pinned_app_id, null)
		assert.equal((await write({})).json.data.pinned_app_id, null)

		// 5) **坏文件不崩，也不影响其它端点。** 这与 index.json 的策略刻意不同：
		//    index 是库的唯一权威（读坏必须 fail loud），prefs 只影响标题栏一颗图标。
		await writeFile(join(dir, 'prefs.json'), '{ this is not json')
		assert.equal((await read()).json.data.pinned_app_id, null, '坏 prefs 一律当成"没有固定"')
		assert.equal((await httpRequest(apiRoute, 'GET', `${API_PREFIX}/apps`)).status, 200, '其它端点照常')
		assert.equal((await write({ pinned_app_id: app.miniapp_id })).json.data.pinned_app_id, app.miniapp_id,
			'坏文件之后仍然写得进去')

		// 6) 写端点必须查来源：跨站 Origin 一律 403。
		const forged = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/prefs`, { pinned_app_id: null },
			{ origin: 'http://evil.example' })
		assert.equal(forged.status, 403)
	})
})

test('请求体过大被拒，而不是把内存吃光', async () => {
	await withHost(async ({ apiRoute }) => {
		const huge = 'x'.repeat(9 * 1024 * 1024)
		const response = await httpRequest(apiRoute, 'POST', `${API_PREFIX}/validate`, { html: huge })
		assert.equal(response.status, 400)
		assert.match(response.json.error, /过大/)
	})
})

// ------------------------------------------------------------------ 模板目录

/**
 * 去掉各类注释后的字节数。
 *
 * 「每个模板 6KB 以内」这条约束是**不含注释**的：注释是写给改模板的人看的，
 * 不该逼着作者在「说清楚这里为什么留白」和「不超预算」之间二选一。
 * 这个剥离是近似的（HTML 注释、块注释、整行 `//`），
 * 近似方向是**偏小**，所以不会把超预算的正文放过去。
 */
function stripComments(html) {
	return html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^[ \t]*\/\/.*$/gm, '')
}

test('GET /templates 返回轻量列表：12 条，且每一条都不含 html', async () => {
	await withHost(async ({ apiRoute }) => {
		const listed = await httpRequest(apiRoute, 'GET', `${API_PREFIX}/templates`)
		assert.equal(listed.status, 200)
		assert.equal(listed.json.ok, true)
		assert.equal(listed.json.data.length, 12)

		for (const entry of listed.json.data) {
			// 列表是给「铺十二张卡片」用的：正文只在该条被选中时取一次。
			assert.ok(!('html' in entry), `${entry.id} 的列表项不该带 html`)
			assert.deepEqual(Object.keys(entry).sort(), ['category', 'en', 'icon', 'id', 'zh'])
			assert.deepEqual(Object.keys(entry.zh).sort(), ['name', 'prompt'])
			assert.deepEqual(Object.keys(entry.en).sort(), ['name', 'prompt'])
		}
		// 「轻」是可以量的：整份列表必须远小于任何一份正文的量级。
		assert.ok(listed.text.length < 3000, `列表响应 ${listed.text.length} 字节，太肥了`)
	})
})

test('每条模板自洽：id 唯一、分类合法、中英文名与提示都非空', async () => {
	assert.equal(MINIAPP_TEMPLATES.length, 12)
	assert.equal(new Set(MINIAPP_TEMPLATES.map((t) => t.id)).size, 12, 'id 必须唯一')

	for (const template of MINIAPP_TEMPLATES) {
		assert.match(template.id, /^[a-z][a-z-]*$/, `${template.id} 不是小写短横线 id`)
		assert.ok(
			TEMPLATE_CATEGORIES.includes(template.category),
			`${template.id} 的分类 ${template.category} 不在模板分类里`
		)
		assert.ok(template.icon.trim().length > 0, `${template.id} 缺 emoji 图标`)
		for (const lang of ['zh', 'en']) {
			assert.ok(template[lang].name.trim().length > 0, `${template.id}.${lang}.name 是空的`)
			assert.ok(template[lang].prompt.trim().length > 0, `${template.id}.${lang}.prompt 是空的`)
		}
	}

	// 每个分类都得真的被用上：一个空分类在面板里就是一个点了没反应的分组。
	for (const category of TEMPLATE_CATEGORIES) {
		assert.ok(
			MINIAPP_TEMPLATES.some((template) => template.category === category),
			`分类 ${category} 下一条模板都没有`
		)
	}
})

test('每份模板正文都是完整文档，且能通过导入校验器', async () => {
	for (const template of MINIAPP_TEMPLATES) {
		const html = template.html
		assert.ok(html.startsWith('<!DOCTYPE html>'), `${template.id} 正文没有以 <!DOCTYPE html> 开头`)
		assert.ok(html.includes('<html'), `${template.id} 缺 <html>`)
		assert.ok(html.includes('<body>'), `${template.id} 缺 <body>`)
		assert.ok(html.includes('<meta charset="utf-8">'), `${template.id} 缺 charset`)
		assert.ok(html.includes('name="viewport"'), `${template.id} 缺 viewport`)

		// 这一条是整组里最要紧的：模板一旦撞上 local_ref_unsupported（相对引用）
		// 或 not_html，用户在面板里点开的就是一个打不开的小程序。
		const report = validateImport(html, [])
		assert.equal(report.blocked, false, `${template.id} 被导入校验挡住了：${JSON.stringify(report.findings)}`)
		assert.deepEqual(
			report.findings.filter((f) => f.severity === 'fatal'),
			[],
			`${template.id} 有致命问题`
		)

		// 留白是产品要求，不是巧合：每条模板都必须在明显的地方留一个缺口，
		// 让用户看一眼就想「改一下」。删掉这句注释，这条测试就会拦下来。
		assert.match(html, /模板在这里留白/, `${template.id} 没有留下一个可改的缺口注释`)

		assert.ok(
			Buffer.byteLength(stripComments(html), 'utf8') <= 6 * 1024,
			`${template.id} 正文超过 6KB（不含注释）`
		)

		// 沙箱里 localStorage 可能直接抛错，键名加前缀是为了不与应用外的名字撞车。
		if (html.includes('localStorage')) {
			assert.ok(html.includes("'app:"), `${template.id} 用了 localStorage 却没有 app: 前缀`)
		}
	}
})

test('GET /templates/{id} 取回完整正文，未知 id 是 404', async () => {
	await withHost(async ({ apiRoute }) => {
		for (const template of MINIAPP_TEMPLATES) {
			const one = await httpRequest(apiRoute, 'GET', `${API_PREFIX}/templates/${template.id}`)
			assert.equal(one.status, 200, `${template.id} 取不到`)
			assert.equal(one.json.ok, true)
			assert.equal(one.json.data.id, template.id)
			assert.equal(one.json.data.html, template.html, `${template.id} 的正文必须逐字一致`)
			assert.equal(one.json.data.zh.name, template.zh.name)
			assert.equal(one.json.data.en.prompt, template.en.prompt)
		}

		const unknown = await httpRequest(apiRoute, 'GET', `${API_PREFIX}/templates/nope`)
		assert.equal(unknown.status, 404)
		assert.equal(unknown.json.ok, false)
		assert.ok(typeof unknown.json.error === 'string' && unknown.json.error.length > 0, '404 也要带一句人能读的原因')
	})
})

test('模板接口是只读 GET：不需要 Origin，也不接受写方法', async () => {
	await withHost(async ({ apiRoute }) => {
		// 浏览器发 GET 不带 Origin，只读分支本来就不要求它 —— 与直出通道同一条理由。
		const noOrigin = await httpRequest(apiRoute, 'GET', `${API_PREFIX}/templates`, undefined, { origin: undefined })
		assert.equal(noOrigin.status, 200, '缺少 Origin 时模板列表仍须可达')
		assert.equal(
			(await httpRequest(apiRoute, 'GET', `${API_PREFIX}/templates/dice`, undefined, { origin: undefined })).status,
			200
		)
		// 但跨站页面依旧读不到：只读不等于不加防。
		assert.equal(
			(await httpRequest(apiRoute, 'GET', `${API_PREFIX}/templates`, undefined, { origin: 'https://evil.example' })).status,
			403
		)
		assert.equal((await httpRequest(apiRoute, 'POST', `${API_PREFIX}/templates`, {})).status, 405)
		assert.equal((await httpRequest(apiRoute, 'DELETE', `${API_PREFIX}/templates/dice`)).status, 405)
	})
})

// ─────────────────────────────────────────────────── skill 注册契约（真实服务）

/**
 * 这一组跑的是**真实**的 `@deepseek-ai/dsh-skill`：抽闭包 → import 真入口 → 真 Context。
 *
 * 装载在模块层做一次（`node:test` 的 `skip` 判定必须在收集期就拿到），asar 读不到就整组跳过，
 * 且跳过必须带上原因 —— 既不能假红（把"没有 DSH"报成契约破了），也不能假绿。
 */
const asarLoaded = loadAsar()
const probeSkip = asarLoaded.error === undefined ? false : skipReason(asarLoaded.error)

test('skill 注册契约（真实服务）：list 看得到、get 拿得到正文 —— 不是只验"注册被调用"', { skip: probeSkip }, async () => {
	const closureDir = await mkdtemp(join(tmpdir(), 'dsh-miniapp-skill-probe-'))
	try {
		// 闭包从 asar 现场抽：**不依赖任何预先留在 /tmp 的东西**（上一轮那份 harness 就是
		// 会话一结束就没了，于是"能跑真实服务"这件事再也复现不出来）。
		const closure = extractPackageClosure(asarLoaded.asar, ['@deepseek-ai/dsh-skill', '@deepseek-ai/cordis'], closureDir)
		console.log(`[skill-probe] ${asarLoaded.note}`)
		console.log(`[skill-probe] ${describeClosure(closure)}（临时目录 ${closureDir}）`)

		const cordis = await import(new URL(`file://${closure.entries.get('@deepseek-ai/cordis')}`).href)
		const skillModule = await import(new URL(`file://${closure.entries.get('@deepseek-ai/dsh-skill')}`).href)
		const SkillPlugin = skillModule.default ?? skillModule

		// Cordis 5 的 `ctx.plugin()` 对 Service 子类不建立提供关系（实测 `ctx.get('skills')`
		// 仍为 undefined），直接构造才等价于生产里 loader 的挂载 —— 构造函数体就是
		// `super(ctx, 'skills')`。
		const ctx = new cordis.Context()
		new SkillPlugin(ctx, {})
		const skills = ctx.get('skills')
		assert.ok(skills !== undefined, '真实的 skills 服务没有挂上来')
		assert.equal(typeof skills.get, 'function', '真实服务上必须有 get —— 那才是"正文进上下文"走的路')

		ctx.effect(() => skills.register(CREATE_MINIAPP_SKILL))

		// ① 目录通道：客户端拿候选 / lexicon / `/` 触发器标签走这条。
		const listed = await skills.list({})
		const entries = Array.isArray(listed) ? listed : listed?.entries ?? []
		const names = entries.map((entry) => entry?.name).filter(Boolean)
		assert.ok(names.includes(CREATE_MINIAPP_SKILL_NAME), `目录里没有 ${CREATE_MINIAPP_SKILL_NAME}：${JSON.stringify(names)}`)

		// ② 解析通道：**F1 就是死在这里**。缺 `source` 时 register 成功、list 正常，
		//    只有这里抛 `loaded skill "…" source must be a string`，而异常被 agent loop
		//    的裸 catch 吞掉 → 用户侧表现为"发送后什么都没发生"。
		const full = await skills.get(CREATE_MINIAPP_SKILL_NAME)
		assert.ok(full !== undefined, 'get 解析不到定义 → 技能正文永远进不了模型上下文')
		assert.equal(typeof full.content, 'string')
		assert.ok(full.content.length > 400, '正文短得不像一份构建契约')
		assert.equal(full.source, CREATE_MINIAPP_SKILL.source)
		assert.equal(full.provider, 'runtime', '运行时注册的 provider 由注册表补')

		// ③ 反空断言：这条测试真的在测**真实服务的校验**，而不是"我们自己不抛就算过"。
		//    故意注册一份缺 `source` 的副本：注册**必须照样成功**、list **必须照样看得见**
		//    （真实服务的不对称就在这里），而 get **必须抛**。
		const withoutSource = { ...CREATE_MINIAPP_SKILL, name: `no-source-${CREATE_MINIAPP_SKILL_NAME}` }
		delete withoutSource.source
		ctx.effect(() => skills.register(withoutSource))
		const listedAfter = await skills.list({})
		const namesAfter = (Array.isArray(listedAfter) ? listedAfter : listedAfter?.entries ?? []).map((entry) => entry?.name)
		assert.ok(namesAfter.includes(withoutSource.name), 'list 不该校验 source —— 真实服务就是在这里放行的')
		await assert.rejects(
			() => skills.get(withoutSource.name),
			/source must be a string/,
			'真实服务的 get 必须因缺 source 而抛错；它不抛，说明这条 probe 没接上真实校验'
		)
	} finally {
		await rm(closureDir, { recursive: true, force: true })
	}
})
