// dsh-miniapp — 座位 / 服务契约检查。
//
// 盯的是同一个已经发生过**三次**的失效模式：插件写下的名字在已安装的 DSH 里漂移了，
// 而这不是一个会报错的错误 ——
//
//   * `ctx.slots.inject("不存在的名字", …)`：ui-renderer 的注入控制器等的是槽位**声明**
//     （`specDynamic(key) === undefined` 时直接返回），于是回调不跑、不报错、没有日志 ——
//     "名字写错了"和"还没轮到"在运行时一模一样。
//   * `ctx.get("不存在的服务")` 返回 undefined：插件里那句 `typeof x.method === "function"`
//     守卫会让它**安静地跳过**，功能凭空消失。
//
// 三次事故：`data-dsh-sidebar-*` 全套 DOM 标记（0 匹配）、`conversation.hero.modeActions`
// 与 `conversation.input.accessory`（0 匹配）、`details` 槽位（0 匹配）。官方插件模板自己的
// smoke 测试也不防这一类 —— 它的假 ctx 同样按定义实现，名字写错照样"注册成功"。
//
// 所以这个文件**不碰假 ctx 的返回值**，直接读**已安装的 asar**里的真实声明来核对：
// 槽位名要存在、kind/scope 要对得上；服务名要有真实的提供点；我们在服务上调的方法
// 要出现在**那个服务自己的声明文件**里。
//
// 为什么必须读 asar、而不是 npm 上的包或 npx 缓存：权威的只有"用户机器上正在跑的那一份"。
// 本项目上一次同类误报，就是因为有人搜了 `~/.npm/_npx/**` 的缓存树 —— 那里躺着**另一个版本**
// 的同名包，于是他得出了"服务名写错了"这个与事实相反的结论（更正记在
// docs/design.zh-CN.md 的「座位契约审计」一节）。
//
// 运行：node --test test/seat-contract.test.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAsar, skipReason as asarSkipReason } from './asar-reader.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

/** 槽位目录的来源：client runner 里那份由 contract 类型派生的表（key/kind/scope/summary…）。 */
const CATALOG_ENTRY = 'node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js'

/**
 * 插件**读**的客户端服务，以及它在每个服务上**调的方法**。
 *
 * 这不是自动推出来的（推不出来：那些 `ctx.get` 都发生在回调里，apply 期不会跑），
 * 而是插件对宿主的**依赖清单**。加一个依赖就要在这里加一行 —— 检查的覆盖面因此是
 * 显式维护的，而不是"碰巧扫到什么"。
 */
const SERVICE_CONTRACT = [
	{ service: 'slots', via: 'inject', methods: [] },
	{ service: 'locale', via: 'inject', methods: [] },
	{ service: 'uiWorkspace', via: 'ctx.get', methods: ['startSession'] },
	{ service: 'sessions', via: 'ctx.get', methods: ['getSnapshot'] },
	{ service: 'layout', via: 'ctx.get', methods: ['openDetails', 'closeDetails'] }
]

/**
 * 插件**期望**的槽位：名字 → {kind, scope}。
 *
 * kind/scope 也是契约的一部分，不只是名字：比如 `conversation.input.dock` 若从 `list`
 * 变成 `single`，我们在那一格上的**两处**注册就会互相顶掉（`single` 只有一个占位者），
 * 而名字检查完全看不出来。
 */
const EXPECTED_SLOTS = new Map([
	['conversation.input.left', { kind: 'list', scope: 'session' }],
	['conversation.input.dock', { kind: 'list', scope: 'session' }],
	['conversation.view', { kind: 'list', scope: 'session' }],
	['conversation.session.header.utilities', { kind: 'list', scope: 'session' }],
	['shell.overlay', { kind: 'list', scope: 'root' }],
	['sidebar.footer.action', { kind: 'list', scope: 'root' }]
])

/**
 * 已知不存在的名字 —— **不是白名单**，是"账目"。
 *
 * 每一条都要：① 现在**确实还不存在**（世界变了就当场红，提醒我们重新评估）；
 * ② 插件**确实还在用**它（否则这一行是死账，删掉）。
 *
 * `details`：0.1.5 的右列是 `rightbar` / `rightbar.session`（single + root / single + session），
 * 由 `ctx.layout.openRightbar(track, fullscreen)` 驱动。`details` 这个名字不存在，
 * 所以「切换布局 → 右侧栏」那条路从来没生效过。**本轮不修**：把抽屉接到
 * `rightbar.session` 是一次产品改动（single 槽位意味着"替换掉 DSH 自己那一列"），
 * 需要单独的任务与验证。已记在 docs/design.zh-CN.md 的已知限制里。
 *
 * `layout.openDetails` / `layout.closeDetails`：同一个功能在**方法层**的第二次漂移 ——
 * 插件调的是 `layout.openDetails()`，而 `dsh-client-ui-layout` 的那个服务上只有
 * `selectPanel` / `beginNavigation` / `toggleSidebar` / `openRightbar` / `closeRightbar`。
 * 插件那句 `typeof layout.openDetails === "function"` 守卫让它安静地跳过。
 * 这正是"判别式要落在**被调用的方法**上，而不是名字存在性"的那个理由。
 */
const KNOWN_ABSENT_SLOTS = new Map([
	['details', '右列在 0.1.5 是 rightbar / rightbar.session + ctx.layout.openRightbar；重接是独立任务']
])
const KNOWN_ABSENT_METHODS = new Map([
	['layout.openDetails', '该方法在 dsh-client-ui-layout 里不存在（只有 selectPanel / openRightbar / closeRightbar …）'],
	['layout.closeDetails', '同 openDetails']
])

// -------------------------------------------------------- asar 读取（**公共件**）

// 读取器**不在这里自己养一份**：`test/asar-reader.mjs`（t14 起存在）就是为这件事抽出来的
// —— 两条读通道（进程内 → 失败退真进程 `cat`）、条目表、形状自检、skip 语义，
// 以及"**全量扫、无 size 上限**"那句输出。原先本文件自带一份拷贝，两份会各自漂移；
// 现在只有一处实现、两个消费者（本文件与 `test/host.test.mjs` 的真实服务 probe）。
//
// 口径的逐字留档见 `docs/design.zh-CN.md` 的「口径：哪些名字做断言，哪些只写文档」。
const asarLoaded = loadAsar()
const asar = asarLoaded.error === undefined ? asarLoaded.asar : undefined
const skipReason = asarLoaded.error === undefined ? false : asarSkipReason(asarLoaded.error)

// ------------------------------------------------------- 插件侧：它到底要了哪些名字

/**
 * 一个**只记录**的假 ctx：记录 `slots.inject` 要过的座位名、`slots.register` 真注册的
 * 条目、以及 `ctx.get` 读过的服务名。它不模拟可见性、不模拟渲染 —— 这个文件要核的是
 * **名字**，行为面由 test/client.test.mjs 负责。
 */
function createRecordingContext() {
	const requestedSlots = []
	const registrations = []
	const servicesRead = []
	const ctx = {
		effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => undefined },
		locale: {
			register() { return () => undefined },
			bind() { return (key) => key },
			getLocale() { return { active: 'zh' } }
		},
		slots: {
			inject(name, callback) {
				requestedSlots.push(name)
				const dispose = callback()
				return () => { if (typeof dispose === 'function') dispose() }
			},
			register(options, component) {
				registrations.push({ options, component })
				return () => undefined
			}
		},
		get(name) { servicesRead.push(name); return undefined }
	}
	return { ctx, requestedSlots, registrations, servicesRead }
}

/** 在 vm 里跑一遍 client.js 的 `apply`，把"它要了什么"收回来。 */
function collectPluginContract() {
	let captured
	const windowStub = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
	const context = vm.createContext({
		window: windowStub,
		console,
		Symbol, Object, Array, String, Number, Math, Date, JSON, Set, Map,
		Blob: class { constructor() {} },
		AbortController,
		fetch: () => Promise.reject(new Error('fetch must not be called at load time')),
		navigator: { clipboard: { writeText: async () => undefined } }
	})
	vm.runInContext(readFileSync(clientPath, 'utf8'), context, { filename: 'client.js' })
	assert.ok(captured !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load')
	const fakeReact = {
		useState: () => [undefined, () => undefined],
		useEffect: () => undefined,
		useRef: () => ({ current: undefined }),
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		createElement: () => undefined
	}
	const module = captured.factory((name) => {
		if (name === 'react') return fakeReact
		throw new Error(`客户端 require 了未预期的模块：${name}`)
	})
	const recorder = createRecordingContext()
	module.apply(recorder.ctx)

	// **光跑 apply 收不全**：有两个座位是"按需"登记的 —— `conversation.view` 只在真的
	// 有会话用到页签时才登记，`details` 只在右侧抽屉被打开时才登记（默认不登记是有意的：
	// 它们是全局/单格座位，一注册就会改变每个会话的样子）。所以这里把它们那条路也走一遍，
	// 否则检查根本看不到它们 —— 而"看不见"正是它要防的那种失败。
	module.sessionViewStore.open('seat-contract', 'app-1')
	module.syncViewTab(recorder.ctx)
	module.openRightPanel(recorder.ctx)

	return { exports: module, ...recorder }
}

// ------------------------------------------------------------------ 契约检查

test('座位契约：插件要的每个槽位名都在已安装 DSH 里存在，且 kind/scope 对得上', { skip: skipReason }, () => {
	const { requestedSlots, registrations } = collectPluginContract()

	// 槽位目录：从 client runner 那份由 contract 类型派生的表里抽 key/kind/scope。
	const catalogEntry = asar.entries.find((entry) => entry.path.endsWith(CATALOG_ENTRY))
	assert.ok(catalogEntry !== undefined, `asar 里找不到槽位目录所在的文件：${CATALOG_ENTRY}`)
	const catalogText = asar.textOf(catalogEntry)
	const catalog = new Map()
	const rowPattern = /key: "([A-Za-z0-9._]+)",\s*kind: "([a-z]+)",\s*scope: "([a-z-]+)"/g
	for (const match of catalogText.matchAll(rowPattern)) {
		catalog.set(match[1], { kind: match[2], scope: match[3] })
	}
	assert.ok(catalog.size >= 50, `只从目录里抽出 ${catalog.size} 个槽位，正则可能失效了`)

	// 插件"要过"的名字 = inject 的实参 ∪ 真注册的 name。两个都要看：
	// inject 的实参才是"它以为存在的名字"，register 的 name 是同一件事的第二次书写。
	const asked = new Set([...requestedSlots, ...registrations.map((entry) => entry.options.name)])
	assert.ok(asked.size >= 5, `只收集到 ${asked.size} 个槽位名，apply 可能没跑起来`)

	const problems = []
	for (const slot of asked) {
		if (KNOWN_ABSENT_SLOTS.has(slot)) continue
		const declared = catalog.get(slot)
		if (declared === undefined) {
			problems.push(`${slot}：已安装 DSH 的槽位目录里没有这个名字 —— inject 会静默等待，功能永远不会出现`)
			continue
		}
		const expected = EXPECTED_SLOTS.get(slot)
		if (expected === undefined) {
			problems.push(`${slot}：存在，但这里的 EXPECTED_SLOTS 没登记它（加了新座位就要登记 kind/scope 期望）`)
			continue
		}
		if (declared.kind !== expected.kind || declared.scope !== expected.scope) {
			problems.push(`${slot}：期望 ${expected.kind}/${expected.scope}，实际 ${declared.kind}/${declared.scope}`)
		}
	}
	assert.deepEqual(problems, [], `座位契约破了：\n  ${problems.join('\n  ')}`)

	// 反向：登记过的期望必须真的还在用（否则是死账）。
	for (const slot of EXPECTED_SLOTS.keys()) {
		assert.ok(asked.has(slot), `EXPECTED_SLOTS 里的 ${slot} 插件已经不再用了，请删掉这一行`)
	}
})

test('座位契约：已知不存在的那几个名字**现在仍然不存在**（世界一变就报警）', { skip: skipReason }, () => {
	const catalogEntry = asar.entries.find((entry) => entry.path.endsWith(CATALOG_ENTRY))
	const catalogText = asar.textOf(catalogEntry)
	const catalog = new Set([...catalogText.matchAll(/key: "([A-Za-z0-9._]+)",/g)].map((match) => match[1]))

	const { requestedSlots, registrations } = collectPluginContract()
	const asked = new Set([...requestedSlots, ...registrations.map((entry) => entry.options.name)])

	for (const [slot, why] of KNOWN_ABSENT_SLOTS) {
		// ① 我们还在用它（否则这一行账该消失）。
		assert.ok(asked.has(slot), `KNOWN_ABSENT_SLOTS 里的 ${slot} 已经没人用了，请删掉这一行`)
		// ② 它现在**仍然**不存在。哪天 DSH 把它加回来了，这条会红 ——
		//    那时该做的不是删掉这一行，而是重新评估把右侧抽屉接回去。
		assert.equal(
			catalog.has(slot), false,
			`${slot} 现在**存在**了（${why}）—— 重新评估这个已知缺口，别默默把它删掉`
		)
	}
})

test('服务契约：插件依赖的每个客户端服务都有真实提供点，且被调的方法就在那个服务的声明文件里', { skip: skipReason }, () => {
	const providerPattern = (service) => [
		`super(ctx, "${service}")`,
		`provide("${service}"`,
		`provide('${service}'`
	]

	/**
	 * 只认**客户端**包里的提供点（`…/lib/client.js`）。
	 *
	 * 这一条是被这条检查自己抓出来的：`sessions` 在宿主里也有一份
	 * （`dsh-session/lib/index.js` 的 `super(ctx, "sessions")`），而插件跑在浏览器里，
	 * 它 `ctx.get("sessions")` 拿到的是 `dsh-api-session-controller/lib/client.js` 里
	 * `rootCtx.reflect.provide("sessions", …)` 的那一份。把两者混为一谈，就会拿宿主的
	 * 方法表去核客户端的调用 —— 又一个"搜错了树"。
	 */
	const isClientBundle = (entry) => /\/lib\/client\.js$/.test(entry.path)

	const report = []
	for (const { service, via, methods } of SERVICE_CONTRACT) {
		// 提供点：客户端包里找 `super(ctx, "name")` 或 `provide("name"`。
		let declaringEntry
		let providerNeedle
		for (const needle of providerPattern(service)) {
			let from = 0
			for (;;) {
				const at = asar.buffer.indexOf(needle, from)
				if (at < 0) break
				const entry = asar.entryAt(at)
				if (entry !== undefined && isClientBundle(entry)) {
					declaringEntry = entry
					providerNeedle = needle
					break
				}
				from = at + needle.length
			}
			if (declaringEntry !== undefined) break
		}
		if (declaringEntry === undefined) {
			report.push(`${service}（经 ${via} 读）：客户端包里找不到提供点 —— ctx.get 会返回 undefined，插件里那句 typeof 守卫会静默跳过`)
			continue
		}
		// 方法级：判别式落在**方法**上，而不是名字存在性。
		// 名字存在、方法不存在 = 同一个坑的第二种形态（layout.openDetails 就是这样）。
		for (const method of methods) {
			if (KNOWN_ABSENT_METHODS.has(`${service}.${method}`)) continue
			if (asar.findIn(declaringEntry, `${method}(`) < 0) {
				report.push(`${service}.${method}()：服务存在（${declaringEntry.path} 里的 ${providerNeedle}），但那个文件里没有这个方法`)
			}
		}
	}
	assert.deepEqual(report, [], `服务契约破了：\n  ${report.join('\n  ')}`)

	// 顺带把"我们到底在核对什么"钉下来：这三条是最容易漂、也最值得看的。
	// （写在断言里，而不是靠上面循环的顺序偶然覆盖。）
	const uiWorkspaceEntry = asar.entryAt(asar.buffer.indexOf('super(ctx, "uiWorkspace")'))
	assert.ok(uiWorkspaceEntry !== undefined, '找不到 uiWorkspace 的声明')
	assert.match(uiWorkspaceEntry.path, /dsh-client-ui-workspace/, 'uiWorkspace 应当由 dsh-client-ui-workspace 提供')
	assert.ok(asar.findIn(uiWorkspaceEntry, 'startSession(') >= 0, 'startSession 必须在这个服务自己的文件里')
})

test('服务契约：已知不存在的那几个方法**现在仍然不存在**', { skip: skipReason }, () => {
	for (const [key] of KNOWN_ABSENT_METHODS) {
		const [service, method] = key.split('.')
		let declaringEntry
		for (const needle of [`super(ctx, "${service}")`, `provide("${service}"`, `provide('${service}'`]) {
			const at = asar.buffer.indexOf(needle)
			if (at < 0) continue
			declaringEntry = asar.entryAt(at)
			break
		}
		assert.ok(declaringEntry !== undefined, `找不到 ${service} 的声明（它若消失了，这条账要重写）`)
		assert.equal(
			asar.findIn(declaringEntry, `${method}(`) < 0, true,
			`${service}.${method} 现在**存在**了 —— 重新评估这个已知缺口（${KNOWN_ABSENT_METHODS.get(key)}），别默默把它删掉`
		)
	}
})

test('被检查的是哪棵树：断言读到的确实是一份 DSH asar，且写进日志便于复验', { skip: skipReason }, () => {
	// 这一条不是形式主义：上一次同类误报正是因为"搜错了树"（npx 缓存里另一个版本的同名包）。
	// 检查结果必须带上"对哪棵树下的结论"，否则同一个错误可以再犯一次。
	assert.ok(asar.entries.length > 1000, `asar 条目只有 ${asar.entries.length} 个，形状不像一份 DSH 安装`)
	const hasRenderer = asar.entries.some((entry) => entry.path.includes('dsh-client-ui-renderer/lib/client.js'))
	const hasConversation = asar.entries.some((entry) => entry.path.includes('dsh-client-ui-conversation/lib/client.js'))
	assert.ok(hasRenderer && hasConversation, 'asar 里没有 DSH 客户端包，这不是我们要核对的那棵树')
	// 打印公共件的 note：里面有路径、条目数、字节数、**读通道**，以及"全量扫、无 size 上限"那句。
	// （不用 statSync 量字节：在 pnpm 下它给出 0 —— 见 asar-reader.mjs 里那段说明。）
	console.log(`[seat-contract] ${asarLoaded.note}`)
})
