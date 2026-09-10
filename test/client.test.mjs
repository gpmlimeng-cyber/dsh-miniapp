// dsh-miniapp — 客户端半边契约测试。
//
// 客户端半边是一个手写的 `window.__ModuleLoader__.load(...)` 模块，浏览器里由 DSH 的
// 客户端加载器求值。这里用 `node:vm` 在同一个形状下把它跑起来，验证那些**重启之后
// 才会暴露**的契约：模块 id 与包名一致、factory 导出的名字与方法、注册到哪些槽位、
// 文案表双语是否对称，以及最关键的 —— iframe 沙箱串与宿主半边**逐字一致**。
//
// 沙箱串在两处各写了一遍（宿主发响应头、客户端写 iframe 属性），它们一旦漂移，
// 后果是安全边界悄悄变松。这条测试就是那道闩。
//
// 运行：node --test test/client.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'

import { IFRAME_SANDBOX as HOST_SANDBOX, EMBED_QUERY as HOST_EMBED_QUERY, EMBED_VALUE as HOST_EMBED_VALUE, RUNNER_HEIGHT_MESSAGE_TYPE as HOST_RUNNER_HEIGHT_TYPE } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const packagePath = join(here, '..', 'package.json')

/** 最小的 React 替身：模块级只做解构，不会真的调用它们。 */
const fakeReact = {
	useState: () => [undefined, () => undefined],
	useEffect: () => undefined,
	useRef: () => ({ current: undefined }),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	createElement: () => undefined
}

/**
 * 在沙箱里求值 client.js，并把 `__ModuleLoader__.load` 的入参交出来。
 *
 * 不执行 `factory` 以外的任何东西，也不给 `window` 别的能力 —— 越界访问会当场炸出来。
 */
function loadClientModule(extra = {}) {
	let captured
	// 传进来的 `window` 替身就是沙箱里那一个 —— **不复制**。
	// 复制的话，测试里改 `window.innerWidth` 只有它自己看得见，而 client.js 读的是
	// 那个原封不动的副本：一条"把视口改小"的测试会安静地测了个假的。
	const windowStub = extra.window ?? {}
	Object.assign(windowStub, { __ModuleLoader__: { load: (spec) => { captured = spec } } })
	const context = vm.createContext(Object.assign({
		window: windowStub,
		console,
		Symbol,
		Object,
		Array,
		String,
		Number,
		Math,
		Date,
		JSON,
		Set,
		Map,
		Blob: class { constructor() {} },
		AbortController,
		fetch: () => Promise.reject(new Error('fetch must not be called at load time')),
		navigator: { clipboard: { writeText: async () => undefined } }
	}, extra.globals ?? {}))
	vm.runInContext(readFileSync(clientPath, 'utf8'), context, { filename: 'client.js' })
	assert.ok(captured !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load')
	return captured
}

/** 求值 factory，拿到客户端模块的导出。 */
function instantiateClientModule() {
	return instantiateClientModuleWith(fakeReact)
}

/** 用指定的 React 替身求值 factory —— 需要一个"能渲染"的替身时用这个。 */
function instantiateClientModuleWith(react, extra) {
	const spec = loadClientModule(extra)
	const module = spec.factory((name) => {
		if (name === 'react') return react
		throw new Error(`客户端 require 了未预期的模块：${name}`)
	})
	return { spec, exports: module }
}

/**
 * 一个"够渲染"的 React 替身：createElement 只记下形状，hooks 是恒等的 no-op。
 *
 * effect 一律**不执行** —— 于是组件函数体可以真的跑一遍（证明它不会在渲染路径上
 * 崩掉、不会把 undefined 画到界面上），但既不会发请求，也不会碰 DOM 或定时器。
 * 没有 hook 位置记账：每个组件只渲染一次，所以不需要。
 */
function createFakeReact() {
	return {
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
		useEffect: () => undefined,
		useLayoutEffect: () => undefined,
		useRef: (initial) => ({ current: initial }),
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		useSyncExternalStore: (subscribe, getSnapshot) => {
			assert.equal(typeof subscribe, 'function', 'useSyncExternalStore 需要一个 subscribe')
			return getSnapshot()
		},
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children })
	}
}

/**
 * 把替身 React 造出来的元素树跑完，并摊平成一个元素列表。
 *
 * 组件（type 是函数）会被**真的调用一次**；DOM 元素（type 是字符串）留在结果里，
 * 于是可以像查询已渲染 DOM 一样断言 role / aria-* / 子元素。
 */
function renderTree(element, out = []) {
	if (element === null || element === undefined || typeof element !== 'object') return out
	if (Array.isArray(element)) {
		for (const child of element) renderTree(child, out)
		return out
	}
	if (typeof element.type === 'function') {
		renderTree(element.type(element.props), out)
		return out
	}
	out.push(element)
	if (Array.isArray(element.children)) renderTree(element.children, out)
	return out
}

/** 一个刚好够用的客户端 ctx，只实现 apply 真正用到的接口。 */
function createFakeClientContext() {
	const registrations = []
	const locales = []
	return {
		registrations,
		locales,
		ctx: {
			effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => undefined },
			locale: {
				register(namespace, table) { locales.push({ namespace, table }); return () => undefined },
				bind() { return (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`) }
			},
			slots: {
				// disposer 必须**真的**撤掉，否则"按需登记 / 最后一格关掉就把页签撤了"
				// 这条行为在测试里根本看不出来。
				inject(name, callback) {
					const dispose = callback()
					return () => { if (typeof dispose === 'function') dispose() }
				},
				register(options, component) {
					const entry = { options, component }
					registrations.push(entry)
					return () => {
						const index = registrations.indexOf(entry)
						if (index >= 0) registrations.splice(index, 1)
					}
				}
			}
		}
	}
}

/**
 * 去掉行注释与块注释，保留字符串字面量。
 *
 * 必要而不是偷懒：这份文件的注释**正当地**讨论了被禁止的写法（为什么会分叉、
 * 为什么不能用某个授权项）。不剥离注释，讨论本身就会让检查误报 ——
 * 与 NomiFun 原版在 rail 面板测试里做的是同一件事。
 */
function stripComments(source) {
	const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
	return withoutBlocks
		.split('\n')
		.map((line) => {
			let inSingle = false
			let inDouble = false
			let out = ''
			for (let i = 0; i < line.length; i += 1) {
				const ch = line[i]
				if (ch === "'" && !inDouble) inSingle = !inSingle
				else if (ch === '"' && !inSingle) inDouble = !inDouble
				if (!inSingle && !inDouble && ch === '/' && line[i + 1] === '/') break
				out += ch
			}
			return out
		})
		.join('\n')
}

/**
 * client.js 是在 `node:vm` 的另一个 realm 里求值的，所以它造出来的对象和数组
 * 原型与本文件里的字面量对不上 —— `assert.deepEqual` 在 strict 模式下比原型，
 * 会因此误报。比较前先落成纯数据。
 */
const plain = (value) => JSON.parse(JSON.stringify(value))

/** 递归收集一个嵌套文案对象里的全部叶子键，用点号连接。 */function leafKeys(value, prefix = '') {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
	const keys = []
	for (const [key, child] of Object.entries(value)) {
		keys.push(...leafKeys(child, prefix.length === 0 ? key : `${prefix}.${key}`))
	}
	return keys.sort()
}

/** 一棵元素子树里的全部文本。 */
function textOf(node) {
	if (typeof node === 'string') return node
	if (Array.isArray(node)) return node.map(textOf).join('')
	if (node !== null && typeof node === 'object') return (node.children ?? []).map(textOf).join('')
	return ''
}

// ------------------------------------------------------------------ 侧栏入口

/**
 * 一个只够跑 mountSidebarEntry 的 DOM 替身。
 *
 * 它不是 DOM：只实现被真正用到的那几个口（createElement / querySelector /
 * appendChild / removeChild / addEventListener / dataset），并在遇到没预期的
 * 选择器时**当场报错**，这样客户端里多出一次 DOM 查询就会在这里暴露出来。
 */
function createFakeDom() {
	const element = (tag) => ({
		tagName: tag.toUpperCase(),
		dataset: {},
		attributes: {},
		listeners: {},
		children: [],
		parentElement: null,
		id: '',
		type: '',
		title: '',
		textContent: '',
		innerHTML: '',
		setAttribute(name, value) { this.attributes[name] = String(value) },
		appendChild(child) {
			if (child.parentElement !== null) child.parentElement.removeChild(child)
			child.parentElement = this
			this.children.push(child)
			return child
		},
		removeChild(child) {
			const at = this.children.indexOf(child)
			if (at >= 0) this.children.splice(at, 1)
			child.parentElement = null
			return child
		},
		addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] ?? []).push(fn) },
		click() { for (const fn of this.listeners.click ?? []) fn() }
	})

	const head = element('head')
	const body = element('body')
	const settingsArea = element('div')
	settingsArea.attributes['data-dsh-sidebar-settings'] = ''
	// 模拟侧栏整体重建：React 拆掉子树那一刻，这个区域查不到。
	const state = { mounted: true }

	const observers = []
	class FakeMutationObserver {
		constructor(callback) { this.callback = callback; this.observed = null; this.connected = false; observers.push(this) }
		observe(target, options) { this.observed = { target, options }; this.connected = true }
		disconnect() { this.connected = false }
		fire() { if (this.connected) this.callback([]) }
	}

	// debounce 用：定时器只登记，由 flush() 手动跑，测试因此完全确定。
	let nextTimer = 0
	const timers = new Map()
	const window = {
		setTimeout: (fn) => { nextTimer += 1; timers.set(nextTimer, fn); return nextTimer },
		clearTimeout: (handle) => { timers.delete(handle) }
	}

	const document = {
		body,
		head,
		createElement: (tag) => element(tag),
		querySelector(selector) {
			if (selector === '[data-dsh-sidebar-settings]') return state.mounted ? settingsArea : null
			if (selector.startsWith('style[data-plugin-css=')) {
				return head.children.find((child) => child.tagName === 'STYLE' && child.dataset.pluginCss !== undefined) ?? null
			}
			throw new Error(`DOM 替身不认识这个选择器：${selector}`)
		}
	}

	return {
		document,
		settingsArea,
		head,
		state,
		observers,
		MutationObserver: FakeMutationObserver,
		window,
		flush() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn() },
		pendingTimers: () => timers.size
	}
}

test('侧栏按钮被真的注入到设置栏里，能自愈，也能被完整清理', () => {
	const dom = createFakeDom()
	const spec = loadClientModule({ globals: { document: dom.document, MutationObserver: dom.MutationObserver }, window: dom.window })
	const exports = spec.factory(() => fakeReact)

	const state = { settingsInjected: false, open: false }
	const ui = {
		get: () => state,
		set: (patch) => Object.assign(state, patch)
	}

	const stop = exports.mountSidebarEntry(ui, (key) => `t:${key}`)
	assert.equal(typeof stop, 'function', '必须返回清理函数')

	// 1. 样式表：去重标记与 dsh-ppt 一致。
	const style = dom.head.children[0]
	assert.equal(style.tagName, 'STYLE')
	assert.equal(style.dataset.plugin, 'dsh-miniapp')
	assert.equal(style.dataset.pluginCss, 'dsh-miniapp/sidebar.css')
	assert.ok(style.textContent.includes('#dsh-miniapp-sidebar-button'))
	// 观察点是 body（body 还没出现时才退到 documentElement）。
	assert.equal(dom.observers[0].observed.target, dom.document.body)
	assert.deepEqual(plain(dom.observers[0].observed.options), { childList: true, subtree: true })

	// 2. 按钮本身：进设置栏、形状与手机按钮一致、文案两个属性都设。
	const button = dom.settingsArea.children[0]
	assert.ok(button !== undefined, '按钮没有被插进设置栏')
	assert.equal(button.id, 'dsh-miniapp-sidebar-button')
	assert.equal(button.type, 'button')
	assert.equal(button.title, 't:nav.entry')
	assert.equal(button.attributes['aria-label'], 't:nav.entry')
	assert.ok(button.innerHTML.includes('stroke-width="1.7"'), '按钮里应当是那个描边图标')

	// 3. 点击打开浮层；注入成功的状态也被写回。
	assert.equal(state.settingsInjected, true, '注入成功后必须报告 settingsInjected')
	button.click()
	assert.equal(state.open, true)

	// 4. 自愈：侧栏被 React 重建 → 按钮掉了 → 观察者叫醒 → 重新插回去。
	dom.settingsArea.removeChild(button)
	assert.equal(dom.settingsArea.children.length, 0)
	dom.observers[0].fire()
	dom.flush()
	assert.equal(dom.settingsArea.children[0], button, '按钮必须能被重新挂回去')
	// debounce 生效：连着一串 DOM 变动只该收敛成一次 ensure。
	dom.observers[0].fire()
	dom.observers[0].fire()
	dom.observers[0].fire()
	assert.equal(dom.pendingTimers(), 1, 'MutationObserver 的变动必须被合并')
	dom.flush()

	// 4b. 侧栏整块消失时报告"没注入"，兜底座位才有机会出现；重建后按钮会重新造一个。
	dom.state.mounted = false
	dom.observers[0].fire()
	dom.flush()
	assert.equal(state.settingsInjected, false, '设置栏消失时必须把 injected 拨回 false')
	assert.equal(button.parentElement, null, '设置栏消失时按钮必须被摘掉')

	dom.state.mounted = true
	dom.observers[0].fire()
	dom.flush()
	assert.equal(state.settingsInjected, true)
	const rebuilt = dom.settingsArea.children[0]
	assert.ok(rebuilt !== undefined, '设置栏重建后按钮必须回来')
	assert.equal(rebuilt.id, 'dsh-miniapp-sidebar-button', '重建出来的仍是同一个按钮')
	assert.ok(rebuilt.innerHTML.includes('stroke-width="1.7"'))

	// 5. 清理：断开观察、摘掉按钮、删掉自己注入的那份样式表。
	stop()
	assert.equal(dom.observers[0].connected, false, '清理必须断开 MutationObserver')
	assert.equal(dom.settingsArea.children.length, 0, '清理必须摘掉按钮')
	assert.equal(dom.head.children.length, 0, '清理必须删掉自己注入的样式表')
})

test('侧栏入口的样式表按 DSH Desktop 的手机按钮几何对齐（含特异度加成）', () => {
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	const declaration = /var SIDEBAR_CSS = ([\s\S]*?)\.join\("\\n"\)/.exec(code)
	assert.ok(declaration !== null, '找不到 SIDEBAR_CSS 常量')
	// 常量是纯字面量拼出来的，把引号与换行去掉就是最终的 CSS 文本。
	const css = declaration[1]

	const must = [
		['width:32px; height:32px', '按钮 32×32（与手机按钮一致）'],
		['border-radius:9px', '按钮 9 圆角'],
		['var(--dsw-alias-label-secondary,#73777f)', '未悬停时的文字色 token'],
		['var(--dsw-alias-label-primary,#202124)', '悬停时的文字色 token'],
		['var(--dsw-alias-interactive-bg-hover,rgba(32,33,36,.08))', '悬停底色 token'],
		['outline:2px solid #4d6bfe; outline-offset:1px', '键盘聚焦环'],
		['right:38px', '给手机按钮留出它的 38px 槽位'],
		['padding-right:76px', '宽轨时那一行要给两个按钮留位置'],
		// preload 的规则特异度是 (0,3,0)，我们靠把类名写两遍顶到 (0,4,0) 来赢，
		// 而不是赌自己的 <style> 排在它后面。
		['[data-dsh-sidebar-settings][data-dsh-sidebar-settings]', '特异度加成（写两遍）'],
		// 页面上没有手机按钮时退回一按钮布局。
		['#dsh-desktop-mobile-button', ':has() 兜底'],
		['[data-dsh-sidebar-wide="false"]', '窄轨（56px 轨道）分支']
	]
	const missing = must.filter(([needle]) => !css.includes(needle)).map(([, label]) => label)
	assert.deepEqual(missing, [], `侧栏样式偏离了手机按钮的几何：${missing.join('、')}`)

	// 所有规则都挂在我们的按钮 id 上，而不是去改宿主自己的元素。
	assert.ok(css.includes('#dsh-miniapp-sidebar-button'), '样式没有挂到自己的按钮 id 上')
	assert.ok(!/^\s*\[data-dsh-sidebar-root\]\s*\{/m.test(css), '不该直接给侧栏根节点写样式')
})

test('侧栏图标是描边风格，与手机按钮同一套画法', () => {
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	const declaration = /var SIDEBAR_ICON_SVG = ([\s\S]*?);\n/.exec(code)
	assert.ok(declaration !== null, '找不到 SIDEBAR_ICON_SVG 常量')
	const svg = declaration[1]

	for (const needle of [
		'viewBox="0 0 24 24"',
		'width="19" height="19"',
		'fill="none"',
		'stroke="currentColor"',
		'stroke-width="1.7"',
		'stroke-linecap="round"',
		'aria-hidden="true"'
	]) {
		assert.ok(svg.includes(needle), `图标缺少 ${needle}`)
	}
	// 描边风，不是文件里那套填充风 —— 后者会把描边属性整个盖掉。
	assert.ok(!svg.includes('ICON_PATHS'), '侧栏图标不该复用填充风图标表')
	assert.ok(!svg.includes('<path d="M4 4h7v7H4V4z'), '侧栏图标不该是填充风的 app 图标')
})

test('ui 状态带着 settingsInjected，并且注入成功时会通知订阅者', () => {
	const { exports } = instantiateClientModule()
	const { ctx, registrations } = createFakeClientContext()
	exports.apply(ctx)

	const ui = registrations.find((r) => r.options.name === 'sidebar.footer.action').options.inject().ui
	assert.equal(ui.get().settingsInjected, false, '初始应当是"还没注入"')

	const seen = []
	const off = ui.subscribe(() => seen.push(ui.get().settingsInjected))
	ui.set({ settingsInjected: true })
	assert.equal(ui.get().settingsInjected, true)
	assert.equal(seen.join(','), 'true')
	off()
	ui.set({ settingsInjected: false })
	assert.equal(seen.join(','), 'true', '退订之后不该再收到通知')
})

test('侧栏兜底按钮与注入版是同一个按钮：32×32 / 9 圆角 / 只显示图标', () => {
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	// 兜底按钮（sidebar.footer.action）里不能再有宽轨时那支文字标签。
	const start = code.indexOf('function SidebarButton(props)')
	assert.ok(start > 0, '找不到 SidebarButton')
	const body = code.slice(start, code.indexOf('\n\t\t}', start))
	assert.ok(!body.includes('props.wide'), '兜底按钮不该再按宽轨切换形态')
	assert.ok(body.includes('width: 32, height: 32'), '兜底按钮应当是 32×32')
	assert.ok(body.includes('borderRadius: 9'), '兜底按钮应当是 9 圆角')
	assert.ok(body.includes('if (injected) return null'), '注入成功后兜底按钮必须让位')
	assert.ok(body.includes('settingsInjected'), '兜底按钮必须读注入状态')
})

// ------------------------------------------------------------------ 模块形状

test('模块 id 与包名一致，导出 name / apply / inject', () => {
	const { spec, exports } = instantiateClientModule()
	const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))

	assert.equal(spec.id, pkg.name, '模块 id 必须与包名一致，否则加载器对不上账')
	assert.equal(typeof spec.factory, 'function')
	assert.equal(exports.name, pkg.name)
	assert.equal(typeof exports.apply, 'function')
	assert.deepEqual([...exports.inject], ['slots', 'locale'])
})

test('apply 注册五个槽位；会话页签是**按需**登记的（默认不显示）', () => {
	const { exports } = instantiateClientModule()
	const { ctx, registrations } = createFakeClientContext()
	exports.apply(ctx)

	const bySlot = new Map(registrations.map((r) => [r.options.name, r]))
	// 这是一份**逐个数出来**的清单：删一个、加一个，都必须在这里显式改一行。
	// （三个 composer 座位同进同退，但它们仍然各占一行 —— 少一行就是少一个入口。）
	assert.deepEqual(
		[...bySlot.keys()].sort(),
		[
			'conversation.composer.dock',
			'conversation.hero.modeActions',
			'conversation.input.accessory',
			'shell.overlay',
			'sidebar.footer.action'
		]
	)
	assert.equal(registrations.length, 5, '同一个座位不该被注册两遍')

	// 会话页签**不在**这份清单里：DSH 的 conversation.view 是全局座位、不分会话，
	// 一注册每个会话的头部都会多一格。所以只在真的有会话用它时才登记。
	assert.equal(bySlot.has('conversation.view'), false, '默认不该有会话页签')
	exports.syncViewTab(ctx)
	assert.equal(registrations.some((r) => r.options.name === 'conversation.view'), false, '没人用它时 sync 也不该登记')

	// 有人用了 → 登记上；再 sync 一次不会重复登记（同一个座位注册两遍就是两个页签）。
	exports.sessionViewStore.open('s1', 'app-1')
	exports.syncViewTab(ctx)
	assert.equal(registrations.filter((r) => r.options.name === 'conversation.view').length, 1)
	exports.syncViewTab(ctx)
	assert.equal(registrations.filter((r) => r.options.name === 'conversation.view').length, 1, '不该登记两遍')

	// 最后一格也关掉 → 撤掉登记，页签自己消失（DSH 会把它从页签条里收走，
	// 若正停在这一格上，resolveActiveView 退回默认的「对话」）。
	exports.closeInSession(ctx, 's1')
	assert.equal(registrations.some((r) => r.options.name === 'conversation.view'), false, '最后一格关掉后页签应当消失')

	// 另一个会话还放着 → 关掉当前这个**不该**把页签收走，它还得留给别人用。
	exports.sessionViewStore.open('s1', 'app-1')
	exports.sessionViewStore.open('s2', 'app-2')
	exports.syncViewTab(ctx)
	exports.closeInSession(ctx, 's1')
	assert.equal(exports.sessionViewStore.snapshot('s1').appId, null)
	assert.equal(registrations.filter((r) => r.options.name === 'conversation.view').length, 1, '还有别的会话在用，页签要留着')
	exports.closeInSession(ctx, 's2')
	assert.equal(registrations.some((r) => r.options.name === 'conversation.view'), false)

	for (const [slotName, registration] of bySlot) {
		// list 类槽位要求 id；用自己独有 id 才是"新增一格"而不是"替换别人的格子"。
		assert.equal(typeof registration.options.id, 'string')
		assert.ok(registration.options.id.length > 0, `${slotName} 缺少 id`)
		assert.equal(typeof registration.component, 'function', `${slotName} 的组件不是函数`)
		assert.equal(typeof registration.options.inject, 'function', `${slotName} 缺少 inject`)
	}

	// inject 必须真的交出 ui 句柄 —— 侧栏入口与全屏浮层靠它共享同一个开关。
	for (const registration of registrations) {
		if (registration.options.name === 'shell.overlay' || registration.options.name === 'sidebar.footer.action') {
			const injected = registration.options.inject()
			assert.ok(injected.ui && typeof injected.ui.set === 'function', '槽位没有拿到共享的 ui 句柄')
		}
	}
})

test('三个 composer 座位用同一个 id / order / inject —— 它们永远同进同退', () => {
	const { exports } = instantiateClientModule()
	const { ctx, registrations } = createFakeClientContext()
	exports.apply(ctx)

	const composerSlots = ['conversation.hero.modeActions', 'conversation.input.accessory', 'conversation.composer.dock']
	const bySlot = new Map(registrations.map((r) => [r.options.name, r]))

	const ids = new Set()
	const orders = new Set()
	const injects = new Set()
	for (const slotName of composerSlots) {
		const registration = bySlot.get(slotName)
		assert.ok(registration !== undefined, `没有注册 ${slotName}`)
		assert.equal(registration.options.id, exports.COMPOSER_ID, `${slotName} 的 id 不是自己的格子`)
		assert.equal(registration.options.locale, 'miniapp', `${slotName} 没有声明文案命名空间`)
		// order 必须避开 PPT 的 20 与 queue/todo/goal 的 0/10/20。
		assert.equal(registration.options.order, 45, `${slotName} 的 order 应当是 45`)
		assert.ok(![0, 10, 20].includes(registration.options.order), `${slotName} 的 order 撞上了已有座位`)
		ids.add(registration.options.id)
		orders.add(registration.options.order)
		injects.add(registration.options.inject)
	}
	assert.equal(ids.size, 1, '三个座位必须用同一个 id')
	assert.equal(orders.size, 1, '三个座位必须用同一个 order')
	assert.equal(injects.size, 1, '三个座位必须共用同一个 inject 工厂')

	// inject 是接收 sessionId 的工厂：同一个 store 跨会话共享，但状态按会话分片。
	const injected = [...injects][0]('session-a')
	assert.ok(injected.mode instanceof exports.MiniAppModeStore, 'inject 没有交出模式状态 store')
	assert.equal(typeof injected.localeOf, 'function', 'inject 没有交出当前界面语言的读取口')
	assert.equal([...injects][0]('session-b').mode, injected.mode, '三个座位必须共享同一份 store 实例')
	// 初始快照是同一份（引用稳定，useSyncExternalStore 才可靠）；一旦某个会话被改动就分叉。
	// 注意 vm 里造出来的对象跨 realm，不能用 deepStrictEqual 比原型，比字段。
	assert.equal(injected.mode.snapshot('session-a'), injected.mode.snapshot('session-b'))
	injected.mode.setActive('session-a', true)
	assert.equal(injected.mode.snapshot('session-a').active, true)
	assert.equal(injected.mode.snapshot('session-b').active, false)
})

test('输入框旁与 composer 下的座位只在空白会话出现（session.blank === false 时返回 null）', () => {
	const { exports } = instantiateClientModule()

	// 这条是「面板不该长在已有对话里」的闩。它必须在**第一个语句**就判掉，
	// 否则组件会先跑 hooks、再返回 null —— 那已经不是"不出现"，而是"白跑一遍"。
	for (const component of [exports.MiniAppStandardInputAccessory, exports.MiniAppStandardComposerDock]) {
		assert.equal(component({ session: { blank: false } }), null)
		assert.equal(component({ session: { blank: false }, sessionId: 's1', mode: undefined }), null)
	}

	// 反过来：判决必须是**函数体的第一句**（而不是"某个等价的变体"或放在 hooks 之后）。
	// 用结构断言而不是源码字符串：字符串断言会惩罚重构，却放过真正的行为回归 ——
	// 这正是这套测试被变异审计抓到的通病。
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	for (const name of ['MiniAppStandardInputAccessory', 'MiniAppStandardComposerDock', 'MiniAppStandardModeAction']) {
		const at = code.indexOf(`function ${name}(props) {`)
		assert.ok(at >= 0, `找不到 ${name}`)
		const firstStatement = code
			.slice(at + `function ${name}(props) {`.length)
			.split('\n')
			.map((line) => line.trim())
			// 跳过注释行：守卫前面允许写注释说明为什么。
			.filter((line) => line !== '' && !line.startsWith('//'))
		assert.match(firstStatement[0] ?? '', /^if \(props\.session === undefined/, `${name} 的守卫必须是第一句`)
	}

	// 三个座位都必须能扛住 `props.session` 缺失 —— 它只是 ui-conversation 透出来的内部
	// zone，不是这个座位声明的契约；渲染期抛 TypeError 会被 DSH **退役整个 entry**（不重试）。
	for (const component of [exports.MiniAppStandardInputAccessory, exports.MiniAppStandardComposerDock, exports.MiniAppStandardModeAction]) {
		assert.equal(component({ session: undefined, sessionId: 's1' }), null)
		assert.equal(component({ session: null, sessionId: 's1' }), null)
		assert.equal(component({ sessionId: 's1' }), null)
	}

	// 空白会话时它们不再返回 null（hero 那个座位同理）。
	const rendering = createFakeReact()
	const { exports: renderingExports } = instantiateClientModuleWith(rendering)
	assert.notEqual(renderingExports.MiniAppStandardInputAccessory({ session: { blank: true }, sessionId: 's1' }), null)
	assert.notEqual(renderingExports.MiniAppStandardComposerDock({ session: { blank: true }, sessionId: 's1' }), null)
	assert.notEqual(renderingExports.MiniAppStandardModeAction({
		session: { blank: true }, sessionId: 's1', mode: new renderingExports.MiniAppModeStore()
	}), null)
	// hero 座位在没有会话的 shell 里（sessionId 缺失）不渲染。
	assert.equal(renderingExports.MiniAppStandardModeAction({
		session: { blank: true }, mode: new renderingExports.MiniAppModeStore()
	}), null)
})

test('模式 chip 的名字永远是「小程序」，样子交给 DSH 的规则', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const t = (key) => key
	const mode = new exports.MiniAppModeStore()
	const props = { session: { blank: true }, sessionId: 's1', mode, t }

	const nodesOf = () => renderTree(exports.MiniAppStandardModeAction(props))
	const chipOf = (nodes) => nodes.find((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined)
	const labelOf = (nodes) => nodes.find((node) => node.type === 'span' && typeof node.children[0] === 'string' && /mode\./.test(node.children[0]))

	// 未激活：图标 + 「小程序」，没有叉。
	const idle = chipOf(nodesOf())
	assert.equal(idle.props['aria-pressed'], false)
	assert.equal(labelOf(nodesOf()).children[0], 'mode.chip')
	assert.equal(nodesOf().filter((n) => n.type === 'svg').length, 1)

	// 激活：**文字一个字都不变**（还是「小程序」，不加"模式"），也不多出关闭叉。
	mode.setActive('s1', true)
	const activeNodes = nodesOf()
	const active = chipOf(activeNodes)
	assert.equal(active.props['aria-pressed'], true)
	assert.equal(labelOf(activeNodes).children[0], 'mode.chip', '选中后名字仍必须是「小程序」')
	assert.ok(!activeNodes.some((n) => n.children.includes('mode.active')), '不该再有「小程序模式」这个说法')
	assert.equal(activeNodes.filter((n) => n.type === 'svg').length, 1, '选中态不该多出关闭叉')

	// 「再点一下退出」只能靠 title 说明（名字没变）。
	assert.equal(active.props.title, 'mode.exit')
	assert.equal(idle.props.title, 'mode.chip')

	// 样子不归我们：DSH 对 hero 模式行的按钮有 `border/padding/border-radius/background/color`
	// 全部 !important 的规则，选中态还有一条全局 `button[data-selected=true]`。
	// 写内联的同类声明只会是死代码（实测过：写上去也是 0px none）。
	assert.equal(active.props['data-selected'], 'true', '选中态要靠 data-selected 让 DSH 自己上色')
	for (const owned of ['border', 'borderColor', 'borderWidth', 'borderStyle', 'borderRadius', 'background', 'color', 'height', 'padding']) {
		assert.equal(active.props.style[owned], undefined, `${owned} 归 DSH 管，不该写内联`)
		assert.equal(idle.props.style[owned], undefined, `${owned} 归 DSH 管，不该写内联`)
	}
	// 只保留 DSH 没管的布局。
	assert.equal(active.props.style.display, 'inline-flex')
	assert.equal(active.props.style.alignItems, 'center')
	assert.equal(idle.props.style.display, 'inline-flex')
})

test('主按钮照 DSH 自己的规范上色：两个主题都能读，且不写死任何绝对色值', () => {
	const code = stripComments(readFileSync(clientPath, 'utf8'))

	// 这一版把主按钮整个换成 DSH 自己的主按钮规范（`.…_primaryButton`）：
	//   background: var(--dsw-alias-button-primary-fill)      （= --dsw-alias-brand-primary）
	//   color:      var(--dsw-alias-label-primary-foreground) （**跟着主题翻面**的那一半）
	//   :hover      background: var(--dsw-alias-button-primary-hover)
	//
	// 为什么这样就"两个主题都能读"：实测 DSH 主题表里
	//   浅色：brand=#0f1115（近黑）+ foreground=#fff
	//   深色：brand=#f9fafb（近白）+ foreground=#0f1115（近黑）
	// 底色与文字色永远是反的，所以两个主题下都是高对比。
	// 反例正是原来那个 bug：底色取 brand（深色下近白）而文字写死 #fff —— 白底白字。
	//
	// 注意 `-invert` 救不了这个：实测它和 brand 在同一个主题下取值完全相同。
	assert.ok(
		code.includes('buttonFill: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))"'),
		'主按钮底色必须取 DSH 的按钮级别名 --dsw-alias-button-primary-fill'
	)
	assert.ok(
		code.includes('buttonHover: "var(--dsw-alias-button-primary-hover, var(--dsw-alias-bg-layer-2))"'),
		'悬停要换成 DSH 的 hover 底色，而不是降透明度'
	)
	assert.ok(
		code.includes('onBrand: "var(--dsw-alias-label-primary-foreground)"'),
		'需要一个"画在实心底色上"的文字色，而且必须跟着主题翻面'
	)
	assert.ok(!code.includes('--dsw-alias-brand-primary-invert'), '-invert 与 brand 同值，别指望它')
	assert.ok(!/background: T\.brand, color: "#fff"/.test(code), 'brand 底色不该配写死的 #fff')

	// 渲染出来看真值：源码里写了 token 不等于画出来用的是 token。
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const rendered = renderTree(exports.PrimaryButton({ label: '创建小程序', onClick() { } }))
	const button = rendered.find((node) => node.type === 'button')
	assert.ok(button !== undefined, 'PrimaryButton 应当画出一枚 button')

	const style = button.props.style
	assert.equal(style.background, 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))')
	assert.equal(style.color, 'var(--dsw-alias-label-primary-foreground)')
	assert.notEqual(style.background, style.color, '底色与文字色必须是两个不同的 token')

	// 几何**不跟** DSH 的 36/18 胶囊走，仍是这个移植版原本那套 32 / 8 圆角 / mini 26。
	// 理由：DSH 里 `.primaryButton` 与 `.secondaryButton`/`.addButton` 共用同一组几何，
	// 而我们的次按钮、搜索框、对话框全是 8 圆角 —— 只把主按钮改成胶囊，
	// 一行里就会一半胶囊一半方角（真机截图确认过）。要换就整体换，那是另一件事。
	assert.equal(style.height, 32, '主按钮高度应当仍是 32（与次按钮同一行视觉一致）')
	assert.equal(style.borderRadius, 8)
	assert.equal(style.padding, '0 14px')
	assert.equal(style.fontSize, 13)
	const miniButton = renderTree(exports.PrimaryButton({ label: 'x', mini: true, onClick() { } }))
		.find((node) => node.type === 'button')
	assert.equal(miniButton.props.style.height, 26, 'mini 档仍是 26')
	assert.equal(miniButton.props.style.borderRadius, 8)

	// 铁律：按钮上不许出现任何写死的颜色。全部走 var(--dsw-*)，
	// 否则浅色/深色就只有一个主题是对的 —— 那正是「深色主题下白底白字」的成因。
	const absolute = /(^|\s)(#(?:[0-9a-f]{3}|[0-9a-f]{6})\b|white\b|black\b|rgba?\(|hsla?\()/i
	for (const [property, value] of Object.entries(style)) {
		if (typeof value !== 'string') continue
		assert.ok(!absolute.test(value), `主按钮的 ${property} 写死了颜色：${value}`)
	}

	// 「同一枚按钮的两种写法必须一致」—— 函数组件与内联常量逐项对齐，
	// 而不是靠注释里的承诺。
	const inline = plain(exports.INLINE_PRIMARY)
	for (const property of ['background', 'color', 'height', 'borderRadius', 'border', 'fontSize', 'padding', 'boxSizing']) {
		assert.deepEqual(
			inline[property], style[property],
			`内联主按钮的 ${property} 与 PrimaryButton 不一致：${inline[property]} vs ${style[property]}`
		)
	}

	// 危险按钮：底色 T.danger + 文字 T.onBrand（不要写死 #fff —— 深色主题的 danger
	// 是偏亮的 #f25a5a，白字会糊）。
	const danger = plain(exports.INLINE_DANGER)
	assert.equal(danger.background, 'var(--dsw-alias-state-error-primary)')
	assert.equal(danger.color, 'var(--dsw-alias-label-primary-foreground)')
	for (const value of Object.values(danger)) {
		if (typeof value !== 'string') continue
		assert.ok(!absolute.test(value), `危险按钮写死了颜色：${value}`)
	}
})

test('输入框旁那一格显示的是「选中了什么」，而不是第二个模式开关', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const t = (key) => key
	const props = {
		session: { blank: true }, sessionId: 's1',
		mode: new exports.MiniAppModeStore(), t, localeOf: () => 'zh'
	}

	// 1. 模式没开：这一格什么都不画。模式开关在 hero 那一行（和「创造模式」并排），
	//    输入框旁边再放一个一模一样的开关只是噪音 —— 这是 dsh-ppt 的分工。
	assert.deepEqual(
		renderTree(exports.MiniAppStandardInputAccessory(props)), [],
		'模式没开时输入框旁不该出现任何东西'
	)

	// 2. 模式开了但还没选模板：仍然是空的（那时只有"该选一个"，没有"选了什么"可说）。
	props.mode.setActive('s1', true)
	props.mode.drainDetail = () => { }
	props.mode.setTemplates('s1', [{
		id: 'pomodoro', icon: '🍅',
		zh: { name: '番茄钟', prompt: '一个番茄钟' }, en: { name: 'Pomodoro', prompt: 'x' }
	}])
	assert.deepEqual(
		renderTree(exports.MiniAppStandardInputAccessory(props)), [],
		'没选模板时输入框旁不该出现任何东西'
	)

	// 3. 选中之后它才出现，名字取自**列表投影**（不需要为此再取一次模板详情）。
	props.mode.select('s1', { id: 'pomodoro' })
	const nodes = renderTree(exports.MiniAppStandardInputAccessory(props))
	const chip = nodes.find((node) => node.type === 'button')
	assert.ok(chip !== undefined, '选中之后必须画出一枚 chip')
	assert.equal(chip.props['data-dsh-miniapp-selection'], 'pomodoro')
	assert.equal(chip.props['aria-label'], 'mode.selectedTemplate: 番茄钟')
	assert.equal(chip.props.title, 'mode.removeTemplate: 番茄钟')
	assert.ok(nodes.some((node) => node.type === 'span' && node.children.includes('🍅')), 'chip 上要带模板自己的 emoji')

	// 4. 按一下 = 取消选择。输入框里已经写好的那句话**不动** —— 它已经是用户的草稿了。
	chip.props.onClick()
	assert.deepEqual(props.mode.snapshot('s1').selectedTemplateId, null, '按一下要能取消选择')
})

test('「直接创建」用模板正文建一个小程序，而且不经过模型', async () => {
	const requests = []
	const fetchStub = async (url, init) => {
		requests.push({
			url: String(url),
			method: (init && init.method) ?? 'GET',
			body: init && init.body !== undefined ? JSON.parse(init.body) : undefined
		})
		if (String(url).includes('/templates/pomodoro')) {
			return {
				ok: true, status: 200,
				json: async () => ({ ok: true, data: { id: 'pomodoro', html: '<html><body><b>25:00</b></body></html>' } })
			}
		}
		return {
			ok: true, status: 200,
			json: async () => ({ ok: true, data: { miniapp_id: 'id-1', name: '番茄钟' } })
		}
	}

	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react, { globals: { fetch: fetchStub } })
	const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)
	const drafts = []

	const store = new exports.MiniAppModeStore()
	store.setActive('s1', true)
	store.drainDetail = () => { }
	store.setTemplates('s1', [{
		id: 'pomodoro', category: 'timer', icon: '🍅',
		zh: { name: '番茄钟', prompt: '一个番茄钟' }, en: { name: 'Pomodoro', prompt: 'x' }
	}])

	const render = () => renderTree(exports.MiniAppTemplatePanel({
		sessionId: 's1', mode: store, t, localeOf: () => 'zh',
		inputActions: { setDraft: (text) => { drafts.push(text) } }
	}))
	const findCreate = (nodes) => nodes.find(
		(node) => node.type === 'button' && node.props['data-action'] === 'create-now'
	)

	// 1. 没选中就没有"直接创建"的对象，所以那个按钮**不该存在**。
	assert.equal(findCreate(render()), undefined, '没选模板时不该出现「直接创建」')

	store.select('s1', { id: 'pomodoro' })
	const idle = findCreate(render())
	assert.ok(idle !== undefined, '选中之后必须出现「直接创建」')
	assert.equal(idle.props.title, 'templates.createNowTitle')

	// 2. 点它：先按 id 取一次正文（列表接口不带 html），再 POST /apps。
	//    `create` 带 html 就是"建好即发布"，所以这里**只有两个请求**，没有 publish。
	await idle.props.onClick()
	assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
		'GET /plugins/dsh-miniapp/api/templates/pomodoro',
		'POST /plugins/dsh-miniapp/api/apps'
	])
	assert.deepEqual(requests[1].body, {
		name: '番茄钟', icon: '🍅', html: '<html><body><b>25:00</b></body></html>'
	})
	assert.equal(store.snapshot('s1').notice, 'templates.created:{"name":"番茄钟"}')

	// 3. 这条路**一次都没有碰输入框** —— 它不做草稿，也不代按回车。
	assert.deepEqual(drafts, [], '「直接创建」不该写输入框')
	assert.ok(!requests.some((r) => r.url.includes('publish')), '建完即发布，不该再打一次 publish')

	// 4. 详情已经在缓存里时不再重复取（同一个模板的预览刚飞过一次）。
	requests.length = 0
	await findCreate(render()).props.onClick()
	assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ['POST /plugins/dsh-miniapp/api/apps'])

	// 5. 出错时给一句能给人看的话，而不是静默失败。
	const failing = instantiateClientModuleWith(createFakeReact(), {
		globals: {
			fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: '磁盘满了' }) })
		}
	})
	const failingStore = new failing.exports.MiniAppModeStore()
	failingStore.setActive('s1', true)
	failingStore.drainDetail = () => { }
	failingStore.setTemplates('s1', [{ id: 'pomodoro', icon: '🍅', zh: { name: '番茄钟' }, en: { name: 'Pomodoro' } }])
	failingStore.patchDetail('s1', 'pomodoro', { status: 'ready', html: '<html></html>' })
	failingStore.select('s1', { id: 'pomodoro' })
	const failingNodes = renderTree(failing.exports.MiniAppTemplatePanel({
		sessionId: 's1', mode: failingStore, t, localeOf: () => 'zh'
	}))
	await findCreate(failingNodes).props.onClick()
	assert.match(failingStore.snapshot('s1').notice, /^templates\.createFailed:/)
	assert.match(failingStore.snapshot('s1').notice, /磁盘满了/)
})

test('选择一个模板会把那句话写进输入框，并且是可编辑的草稿而不是直接发送', () => {
	const { exports } = instantiateClientModule()

	const calls = []
	const inputActions = {
		setDraft: (text) => { calls.push(text) },
		submit: () => { calls.push('<submit>') }
	}
	assert.equal(exports.writeInputDraft(inputActions, '一个番茄钟：25 分钟专注 + 5 分钟休息，结束时提醒'), true)
	assert.deepEqual(calls, ['一个番茄钟：25 分钟专注 + 5 分钟休息，结束时提醒'])
	// 只写草稿，绝不替用户按下回车 —— 那正是这个设计的关键一步。
	assert.ok(!calls.includes('<submit>'))

	// 更老的宿主上没有这个 prop 时，不要假装成功。
	assert.equal(exports.writeInputDraft(undefined, 'x'), false)
	assert.equal(exports.writeInputDraft({}, 'x'), false)
	assert.equal(exports.writeInputDraft({ setDraft: 'not-a-function' }, 'x'), false)
	assert.equal(exports.writeInputDraft(inputActions, ''), false)
	assert.equal(exports.writeInputDraft({ setDraft: () => { throw new Error('nope') } }, 'x'), false)
})

test('模板文案按界面语言取面，缺面时回落而不是画出 undefined', () => {
	const { exports } = instantiateClientModule()
	const template = {
		id: 'pomodoro',
		category: 'timer',
		icon: '🍅',
		zh: { name: '番茄钟', prompt: '一个番茄钟：25 分钟专注 + 5 分钟休息，结束时提醒' },
		en: { name: 'Pomodoro', prompt: 'A pomodoro timer' }
	}

	assert.deepEqual(plain(exports.templateFace(template, 'zh')), template.zh)
	assert.deepEqual(plain(exports.templateFace(template, 'en')), template.en)
	// 带地区的 id 回落到基础语言。
	assert.deepEqual(plain(exports.templateFace(template, 'zh-CN')), template.zh)
	// 不认识的语言回落到 en（DSH 的回退语言）。
	assert.deepEqual(plain(exports.templateFace(template, 'fr')), template.en)
	assert.deepEqual(plain(exports.templateFace(null, 'zh')), { name: '', prompt: '' })
	assert.deepEqual(plain(exports.templateFace({}, 'zh')), { name: '', prompt: '' })
	// 分类标签：认识的走文案表，不认识的回显原名，而不是显示裸 key。
	const t = (key) => key
	assert.equal(exports.templateCategoryLabel(t, 'all'), 'templates.category.all')
	assert.equal(exports.templateCategoryLabel(t, 'timer'), 'templates.category.timer')
	assert.equal(exports.templateCategoryLabel(t, 'brand-new'), 'brand-new')
	assert.equal(exports.templateCategoryLabel(t, ''), 'templates.category.unknown')
})

test('模式状态按会话分片，订阅的粒度也是会话', () => {
	const { exports } = instantiateClientModule()
	const store = new exports.MiniAppModeStore()

	// 没被碰过的会话拿到同一份初始快照（引用稳定，useSyncExternalStore 才可靠）。
	assert.equal(store.snapshot('a'), store.snapshot('b'))
	assert.equal(store.snapshot('a').active, false)
	assert.equal(store.snapshot('a').selectedTemplateId, null)
	assert.equal(store.snapshot('a').templates.length, 0)

	const seenA = []
	const seenB = []
	const offA = store.subscribe('a', () => seenA.push(store.snapshot('a').active))
	store.subscribe('b', () => seenB.push(store.snapshot('b').active))

	store.setActive('a', true)
	assert.equal(store.snapshot('a').active, true)
	assert.equal(store.snapshot('b').active, false, '模式是会话的属性，不是全局开关')
	assert.equal(seenA.join(','), 'true')
	assert.equal(seenB.length, 0, '另一个会话的订阅者不该被叫醒')

	store.setTemplates('a', [{ id: 'x' }, { id: 'y' }])
	assert.equal(store.snapshot('a').templates.map((entry) => entry.id).join(','), 'x,y')
	assert.equal(store.snapshot('a').loading, false)

	store.select('a', { id: 'y' })
	assert.equal(store.snapshot('a').selectedTemplateId, 'y')
	// 模板列表换了、选中的那条没了 —— 选中态必须跟着消失，不留悬空 id。
	store.setTemplates('a', [{ id: 'x' }])
	assert.equal(store.snapshot('a').selectedTemplateId, null)

	// 离开模式会连选中态一起清掉。
	store.select('a', { id: 'x' })
	store.setError('a', 'boom')
	assert.equal(store.snapshot('a').error, 'boom')
	assert.equal(store.snapshot('a').loading, false)
	store.setActive('a', false)
	assert.equal(store.snapshot('a').active, false)
	assert.equal(store.snapshot('a').selectedTemplateId, null)
	assert.equal(store.snapshot('a').error, '')

	// 退订只影响这一个会话的那一个 listener。
	const before = seenA.length
	offA()
	store.setActive('a', true)
	assert.equal(seenA.length, before, '退订之后不该再收到通知')
	assert.equal(seenB.length, 0)
})

test('详情队列是串行的：一次只飞一个，重复请求会被去重', () => {	const { exports } = instantiateClientModule()
	const store = new exports.MiniAppModeStore()
	const requested = []
	// 把 loader 换成记账版本，避免真的发请求。
	store.drainDetail = function () {
		const queue = this.queues.get('s') ?? []
		if (this.inflight.has('s') || queue.length === 0) return
		const id = queue.shift()
		this.inflight.set('s', id)
		requested.push(id)
	}

	store.requestDetail('s', 'a', false)
	store.requestDetail('s', 'b', false)
	store.requestDetail('s', 'a', false) // 已经在飞，不该被排第二遍
	assert.equal(requested.join(','), 'a', '一次只能有一个请求在飞')
	assert.equal(store.snapshot('s').detail.a.status, 'loading')
	assert.equal(store.snapshot('s').detail.b.status, 'loading')

	// 悬停（urgent）把这张卡提到队首 —— 用户马上要看它；普通请求按到达顺序排。
	store.requestDetail('s', 'c', true)
	store.requestDetail('s', 'd', false)
	assert.equal(store.queues.get('s').join(','), 'c,b,d', 'urgent 要插到队首')

	// 前一个落地后，队列自己往下走。
	store.inflight.delete('s')
	store.drainDetail('s')
	assert.equal(requested.join(','), 'a,c')

	// 已经在飞的不会被重复排队。
	store.requestDetail('s', 'c', false)
	assert.equal(requested.join(','), 'a,c', '同一个 id 不该被重复请求')

	// 已经有 html 的卡片不再请求第二次。
	store.patchDetail('s', 'e', { status: 'ready', html: '<p>hi</p>' })
	store.requestDetail('s', 'e', true)
	assert.ok(!requested.includes('e'), '已经拿到详情的不该再请求')
	assert.equal(store.queues.get('s').join(','), 'b,d')
})

// ------------------------------------------------------------------ 模板面板

/** 造一份"服务端已经答过"的模式状态：进入模式、有两条模板、其中一条详情已就绪。 */
function createPanelFixture(renderingExports, { withFrame = true } = {}) {
	const store = new renderingExports.MiniAppModeStore()
	const sessionId = 's1'
	store.setActive(sessionId, true)
	store.setTemplates(sessionId, [
		{
			id: 'pomodoro', category: 'timer', icon: '🍅',
			zh: { name: '番茄钟', prompt: '一个番茄钟：25 分钟专注 + 5 分钟休息，结束时提醒' },
			en: { name: 'Pomodoro', prompt: 'A pomodoro timer' }
		},
		{
			id: 'todo', category: 'note', icon: '✅',
			zh: { name: '待办清单', prompt: '一个待办清单' },
			en: { name: 'To-do list', prompt: 'A to-do list' }
		}
	])
	if (withFrame) {
		// 测试里不发请求：直接把详情塞成"已就绪"。
		// **两条都塞** —— 预览是常驻的，每张详情就绪的卡都该有自己的 iframe，
		// 不再是"只有被选中的那张"。
		store.drainDetail = function () { }
		store.select(sessionId, { id: 'pomodoro' })
		store.patchDetail(sessionId, 'pomodoro', {
			status: 'ready', html: '<html><body><b>25:00</b></body></html>'
		})
		store.patchDetail(sessionId, 'todo', {
			status: 'ready', html: '<html><body><i>todo</i></body></html>'
		})
	}
	const drafts = []
	const element = renderingExports.MiniAppTemplatePanel({
		sessionId,
		mode: store,
		t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
		localeOf: () => 'zh',
		inputActions: { setDraft: (text) => { drafts.push(text) } }
	})
	return { store, sessionId, element, drafts }
}

test('模板面板：分类 tab 有 tablist/tab 语义，预览是真的沙箱 iframe', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const { element } = createPanelFixture(exports)
	assert.notEqual(element, null, '进入模式后模板面板必须铺开')

	const nodes = renderTree(element)

	// 分类 tab：role=tablist + 每个 tab 是 role=tab 且带 aria-selected。
	const tablist = nodes.find((node) => node.props.role === 'tablist')
	assert.ok(tablist !== undefined, '分类栏缺少 role="tablist"')
	assert.equal(typeof tablist.props['aria-label'], 'string')
	const tabs = nodes.filter((node) => node.props.role === 'tab')
	assert.equal(tabs.length, 3, '「全部」加上数据里出现的两个分类')
	assert.equal(tabs[0].props['aria-selected'], true, '默认选中「全部」')
	assert.equal(tabs[1].props['aria-selected'], false)
	assert.equal(tabs.map((tab) => tab.children[0]).join('|'), 'templates.category.all|templates.category.timer|templates.category.note')

	// 预览是真渲染，而且是**常驻**的：详情就绪的卡各自挂一个沙箱 iframe，
	// 不必先把指针移上去（那是旧行为，`armed` 那套已经删掉）。
	const frames = nodes.filter((node) => node.type === 'iframe')
	assert.equal(frames.length, 2, '每张详情就绪的卡都该有自己的预览，而不是只有被选中的那张')
	assert.equal(frames[0].props.sandbox, HOST_SANDBOX, '缩略图必须复用同一条沙箱授权串')
	assert.equal(frames[0].props.sandbox, 'allow-scripts allow-forms allow-popups allow-modals')
	// srcDoc 现在是「模板正文 + 一段只用来量高度的脚本」：它插在 </body> 之前，
	// 所以正文原样保留在开头。量高协议的完整断言在下面单独一条测试里。
	assert.equal(frames[0].props.srcDoc.startsWith('<html><body><b>25:00</b>'), true,
		'预览文档必须以模板自己的正文开头')
	assert.ok(frames[0].props.srcDoc.endsWith('</body></html>'), '量高脚本要插在 </body> 之前，不能破坏文档结构')
	assert.ok(frames[1].props.srcDoc.startsWith('<html><body><i>todo</i>'), '每张卡渲染的是自己的模板')
	assert.ok(frames[0].props.style.transform.startsWith('scale('), '缩略图应当整体缩放')
	assert.equal(frames[0].props.style.pointerEvents, 'none', '缩略图不该抢走卡片的点击')

	// 常驻不等于常开：iframe 的挂载仍然由"这张卡在不在可视区"决定，
	// 所以源码里必须留着那条 inView 判决，且不再有任何悬停延迟。
	const source = stripComments(readFileSync(clientPath, 'utf8'))
	assert.ok(source.includes('var frame = inView && html !== ""'), '预览该由"在不在可视区"决定')
	assert.ok(!source.includes('armed'), '悬停点亮预览那套必须删干净')

	// 每张卡都是可点的按钮，并且带 aria-pressed。
	const cards = nodes.filter((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined)
	assert.equal(cards.length, 2)
	assert.equal(cards[0].props['aria-pressed'], true)
	assert.equal(cards[1].props['aria-pressed'], false)
})

test('模板面板的三种空态：加载中 / 出错可重试 / 空分类', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

	const render = (mutate) => {
		const store = new exports.MiniAppModeStore()
		store.setActive('s1', true)
		mutate(store)
		return renderTree(exports.MiniAppTemplatePanel({
			sessionId: 's1', mode: store, t, localeOf: () => 'zh', inputActions: {}
		}))
	}

	// 加载中：列表还没回来。
	const loading = render((store) => store.setLoading('s1', true))
	assert.ok(loading.some((node) => node.children?.[0] === 'templates.loading'))

	// 出错：必须把后端那句话原样带出来，并且给一个重试按钮。
	const failed = render((store) => store.setError('s1', 'HTTP 500'))
	const alert = failed.find((node) => node.props.role === 'alert')
	assert.ok(alert !== undefined, '加载失败必须是一个 role="alert"')
	assert.ok(textOf(alert).includes('HTTP 500'), '加载失败必须回显后端消息')
	assert.ok(
		failed.some((node) => node.type === 'button' && textOf(node) === 'templates.retry'),
		'加载失败必须能重试'
	)

	// 空：列表回来了但没有模板。
	const empty = render((store) => store.setTemplates('s1', []))
	assert.ok(empty.some((node) => node.children?.[0] === 'templates.empty'))

	// 面板没进入模式时什么都不渲染 —— 不给会话留 DOM。
	const inactive = exports.MiniAppTemplatePanel({
		sessionId: 's1', mode: new exports.MiniAppModeStore(), t, localeOf: () => 'zh', inputActions: {}
	})
	assert.equal(inactive, null)
})

// ------------------------------------------------- 瀑布流 / 分类条 / 预览量高 / 卡片内容

/**
 * 一个**会真的执行 effect** 的 React 替身。
 *
 * `createFakeReact` 的 useEffect 是 no-op（绝大多数组件测试只关心渲染结果），
 * 但"挂上监听 / 清理时摘掉"这件事只有真的跑一遍 effect 才看得见。
 *
 * 它顺便模拟 React 的 ref 提交：`createElement` 遇到 `props.ref` 就把节点回填进去 ——
 * 真实 React 在 commit 阶段就是这么做的，而卡片的 message handler 需要
 * `frameRef.current` 真的是那个 iframe 节点才可能认领消息。
 *
 * `states` 收着每个 useState 的槽位，于是"handler 真的把高度写进状态了吗"
 * 可以被观测到，而不是只能相信它。
 */
function createEffectReact() {
	const cleanups = []
	const states = []
	/** 页面上那一个 iframe 的窗口对象（见 createElement 里的说明）。 */
	let frameWindow
	return {
		cleanups,
		states,
		useState: (initial) => {
			const slot = { value: typeof initial === 'function' ? initial() : initial }
			states.push(slot)
			return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
		},
		useEffect: (fn) => {
			const cleanup = fn()
			if (typeof cleanup === 'function') cleanups.push(cleanup)
		},
		useLayoutEffect: () => undefined,
		useRef: (initial) => ({ current: initial }),
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		createElement: (type, props, ...children) => {
			const node = { type, props: props ?? {}, children }
			// 假的 DOM 不会给 iframe 造一个真的 contentWindow，而"认领消息"靠的正是它。
			// 这里把**同一个**窗口对象绑到每个 iframe 节点上：认领比的是引用，
			// 所以它必须跨渲染稳定 —— 每次换一个新的，就变成"伪造 source"那一种形状了。
			if (type === 'iframe') {
				if (frameWindow === undefined) frameWindow = { name: 'runner-frame' }
				node.contentWindow = frameWindow
			}
			if (node.props.ref !== undefined && node.props.ref !== null) node.props.ref.current = node
			return node
		}
	}
}

test('模板瀑布流：四列、卡片不被拆断、列宽公式一个字没改', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const { element } = createPanelFixture(exports)
	const nodes = renderTree(element)

	// 1. 容器是 CSS 多列，不是行对齐的栅格。
	const grid = nodes.find((node) => node.props.style && node.props.style.columns !== undefined)
	assert.ok(grid !== undefined, '瀑布流容器必须有 columns')
	assert.equal(grid.props.style.columns, exports.PANEL_COLUMNS)
	assert.equal(grid.props.style.columns, 4)
	assert.equal(grid.props.style.columnGap, exports.PANEL_GRID_GAP + 'px')
	assert.equal(grid.props.style.columnGap, '14px')
	// 行对齐的栅格必须彻底消失：留着它，同一排的卡片又会被拉成等高。
	assert.equal(grid.props.style.gridTemplateColumns, undefined, '不该再有行对齐栅格')

	// 2. 卡片是块级盒子 + break-inside: avoid —— 否则多列会把一张卡从中间切开
	//    （上面留半张预览、下面留半句话）。
	const cards = nodes.filter((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined)
	assert.equal(cards.length, 2)
	for (const card of cards) {
		assert.equal(card.props.style.breakInside, 'avoid', '卡片必须禁止被多列拆断')
		assert.equal(card.props.style.display, 'block', 'break-inside 只对块级盒子生效')
		assert.equal(card.props.style.width, '100%')
	}

	// 3. 列宽公式**逐字不变**。它是缩放系数的来源：改了它，预览就会整体缩放错位。
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	assert.ok(
		code.includes('Math.floor((gridWidth - PANEL_GRID_GAP * (PANEL_COLUMNS - 1)) / PANEL_COLUMNS)'),
		'列宽公式必须保持原样'
	)
	assert.ok(code.includes('Math.round(viewport.clientWidth)'), '列宽仍由可视区宽度量出来')
})

test('分类条照 dsh-ppt：胶囊 tab，选中是半透明灰底、悬停只提亮文字', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const { element } = createPanelFixture(exports)
	const nodes = renderTree(element)
	const tabs = nodes.filter((node) => node.props.role === 'tab')

	// 只渲染**非空**分类：fixture 的数据里只出现 timer / note 两个分类，
	// 所以是「全部」+ 这两个 = 3 个 tab。calc / decide / play 一个模板都没有，
	// 就不该出现空 tab —— 12 个模板撑不起更多分类，空 tab 是假的分类。
	assert.deepEqual(
		tabs.map((tab) => tab.children[0]),
		['templates.category.all', 'templates.category.timer', 'templates.category.note']
	)

	// 形状照抄 PPT 的 `.…_categoryTabs button`：无边框、胶囊圆角、5×10 内边距、11px。
	for (const tab of tabs) {
		assert.equal(tab.props.style.border, 0)
		assert.equal(tab.props.style.borderRadius, 999, '分类 tab 是胶囊形（PPT 的 border-radius:999px）')
		assert.equal(tab.props.style.padding, '5px 10px')
		assert.equal(tab.props.style.fontSize, 11)
	}

	const [all, timer] = tabs
	// 选中：半透明灰底 + 主文字色。**不是**彩色、**不加粗** —— 它标记"当前筛选"，
	// 不是强调（彩色留给真正的动作，比如模式 chip）。
	assert.equal(all.props['aria-selected'], true)
	assert.equal(all.props.style.background, 'var(--dsw-alias-interactive-bg-hover)')
	assert.equal(all.props.style.color, 'var(--dsw-alias-label-primary)')
	assert.notEqual(all.props.style.fontWeight, 600, '选中态不该加粗（PPT 只换底色）')

	// 未选中：caption 色、透明底。
	assert.equal(timer.props['aria-selected'], false)
	assert.equal(timer.props.style.color, 'var(--dsw-alias-label-caption)')
	assert.equal(timer.props.style.background, 'transparent')
	assert.equal(timer.props.style.fontWeight, 400)

	// 字号恒定：选中只换底色与颜色，点一下不会让这一行文字左右抖动。
	assert.equal(new Set(tabs.map((tab) => tab.props.style.fontSize)).size, 1)

	// 悬停态只提亮文字、不铺底 —— 铺底会和选中态撞成同一个样子。
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	assert.ok(
		code.includes(': hover ? { color: T.text1 } : null'),
		'悬停应当只提亮文字、不铺底（PPT 的 :hover 也是只改 color）'
	)

	// 键盘可达的语义一个字都没动。
	const tablist = nodes.find((node) => node.props.role === 'tablist')
	assert.equal(typeof tablist.props['aria-label'], 'string')
	assert.equal(tablist.props.style.overflowX, 'auto', '分类条放不下时要能横滚')
	assert.equal(tablist.props.style.scrollbarWidth, 'none', '分类条上不该出现滚动条')
})

test('预览量高协议之一：脚本只进预览，插在 </body> 之前', () => {
	const { exports } = instantiateClientModule()
	const script = exports.previewMeasureScript()
	// 与宿主那半边同一条教训：字符串断言查不出语法错误，而一段坏脚本会让整个
	// 模板预览的自适应高度静默失效。所以必须真的解析它。
	assert.doesNotThrow(
		() => new Function(script.replace(/^<script>/, '').replace(/<\/script>$/, '')),
		'预览量高脚本里的 JS 必须是合法的'
	)

	// 脚本本身只做三件事：量高度、postMessage、高度变化时重发。
	// 「不读页面内容、不碰网络、不写任何存储」是这段代码的契约，逐条钉住。
	assert.ok(script.startsWith('<script>') && script.endsWith('</script>'))
	assert.ok(script.includes(exports.PREVIEW_MESSAGE_TYPE), '消息类型必须来自那个常量')
	assert.ok(script.includes('parent.postMessage'))
	assert.ok(script.includes('scrollHeight'))
	assert.ok(script.includes('ResizeObserver'))
	assert.ok(script.includes('addEventListener("resize"'), '没有 ResizeObserver 时要退到 window.resize')
	assert.ok(!script.includes('document.write'))
	assert.ok(!script.includes('innerHTML'), '量高脚本不该读页面内容')
	for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie', 'fetch(', 'XMLHttpRequest', 'import(']) {
		assert.ok(!script.includes(forbidden), `量高脚本不该出现 ${forbidden}`)
	}

	// 注入位置：`</body>` 之前 > `</html>` 之前 > 末尾。
	assert.equal(
		exports.withPreviewMeasure('<html><body><b>x</b></body></html>', script),
		'<html><body><b>x</b>' + script + '</body></html>'
	)
	assert.equal(
		exports.withPreviewMeasure('<HTML><BODY>x</BODY></HTML>', script),
		'<HTML><BODY>x' + script + '</BODY></HTML>',
		'找 </body> 必须大小写不敏感 —— 模板自己可能写大写'
	)
	assert.equal(
		exports.withPreviewMeasure('<html><p>x</p></html>', script),
		'<html><p>x</p>' + script + '</html>',
		'没有 </body> 就退到 </html> 之前'
	)
	assert.equal(
		exports.withPreviewMeasure('<p>x</p>', script),
		'<p>x</p>' + script,
		'两个都没有（片段文档）就追加到末尾 —— 浏览器解析 srcDoc 时会补出 body，脚本照样跑'
	)
	assert.equal(exports.withPreviewMeasure('', script), '', '空文档不该被塞进一段脚本')
	assert.equal(exports.withPreviewMeasure(null, script), null)
	assert.equal(exports.withPreviewMeasure(undefined, script), undefined)

	// 整份客户端里**只有一处** srcDoc，而且就是预览那一处：
	// 运行页的 iframe 走 `src=SERVE/...`（宿主直出已发布快照），
	// 所以那段量高脚本一个字节都进不了真实运行的小程序。
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	const srcDocs = [...code.matchAll(/srcDoc:\s*([^\n]+)/g)].map((match) => match[1].trim().replace(/,$/, ''))
	assert.deepEqual(
		srcDocs, ['withPreviewMeasure(html, previewMeasureScript())'],
		'只有预览这一处 srcDoc，而且必须经过量高脚本注入'
	)
	assert.ok(
		code.includes('src: cornerFrameUrl(app.miniapp_id, props.embed === true)'),
		'运行页必须仍然是宿主直出的 src，不得改走 srcDoc'
	)
})

test('预览量高协议之二：只认自己那个 iframe 发来的、形状正确的消息', () => {
	const { exports } = instantiateClientModule()
	const TYPE = exports.PREVIEW_MESSAGE_TYPE
	const frameWindow = { name: 'this-iframe' }
	const accept = (event) => exports.previewHeightFromMessage(event, frameWindow)

	// 合法：从这个 iframe 发出、类型对、高度是有限正数。
	assert.equal(accept({ source: frameWindow, origin: 'null', data: { type: TYPE, height: 620 } }), 620)
	assert.equal(
		accept({ source: frameWindow, origin: 'null', data: { type: TYPE, height: 620.4 } }), 621,
		'向上取整：宁可多留半像素，也别把内容底部切掉'
	)

	// 伪造：页面上任何别的 iframe（包括别的插件）发来的消息一律不认。
	// **注意这两种情况的 origin 都是字符串 "null"** —— 沙箱没有 allow-same-origin，
	// 预览文档活在不透明源里，消息的 origin 永远是 "null"，跟伪造者长得一模一样。
	// 这就是为什么认领只能靠 event.source，不能靠 origin。
	assert.equal(accept({ source: { name: 'someone-else' }, origin: 'null', data: { type: TYPE, height: 620 } }), 0)
	assert.equal(accept({ source: frameWindow, origin: 'null', data: { type: TYPE, height: 620 } }), 620)

	// 类型不对：`message` 是整页共享的，DSH 自己、别的插件都在往上发消息。
	assert.equal(accept({ source: frameWindow, data: { type: 'dsh:whatever', height: 620 } }), 0)
	assert.equal(accept({ source: frameWindow, data: { type: TYPE } }), 0)
	assert.equal(accept({ source: frameWindow, data: { type: TYPE, height: undefined } }), 0)

	// 非法 height：NaN / Infinity / 负数 / 0 / 数字字符串 / 各种非数字。
	// 放进去任何一个，卡片就会被撑成一堵墙或者塌成 0。
	for (const bad of [NaN, Infinity, -Infinity, -1, 0, '620', '1e999', null, undefined, {}, [], true]) {
		assert.equal(
			accept({ source: frameWindow, data: { type: TYPE, height: bad } }), 0,
			`height=${JSON.stringify(bad) ?? String(bad)} 必须被拒绝`
		)
	}

	// 事件本身不成形（第三方发的 null、字符串 data）也不能炸。
	assert.equal(accept(null), 0)
	assert.equal(accept(undefined), 0)
	assert.equal(accept({}), 0)
	assert.equal(accept({ source: frameWindow, data: null }), 0)
	assert.equal(accept({ source: frameWindow, data: 'a string' }), 0)
	// iframe 还没挂上（contentWindow 取不到）时一律不认。
	assert.equal(exports.previewHeightFromMessage({ source: frameWindow, data: { type: TYPE, height: 10 } }, null), 0)
	assert.equal(exports.previewHeightFromMessage({ source: frameWindow, data: { type: TYPE, height: 10 } }, undefined), 0)
})

test('预览量高协议之三：卡片真的挂上监听、认领消息、并在清理时摘掉', () => {
	const listeners = []
	const fakeWindow = {
		addEventListener(name, fn) { listeners.push({ name, fn }) },
		removeEventListener(name, fn) {
			const at = listeners.findIndex((entry) => entry.name === name && entry.fn === fn)
			if (at >= 0) listeners.splice(at, 1)
		}
	}
	const react = createEffectReact()
	const { exports } = instantiateClientModuleWith(react, { window: fakeWindow })

	const template = {
		id: 'pomodoro', category: 'timer', icon: '🍅',
		zh: { name: '番茄钟', prompt: '一个番茄钟：25 分钟专注 + 5 分钟休息，结束时提醒' },
		en: { name: 'Pomodoro', prompt: 'A pomodoro timer' }
	}
	const nodes = renderTree(exports.MiniAppTemplateCard({
		t: (key) => key,
		mode: { requestDetail() { } },
		sessionId: 's1',
		template,
		face: exports.templateFace(template, 'zh'),
		detail: { status: 'ready', html: '<html><body>x</body></html>' },
		selected: false,
		viewport: null,
		cardWidth: 225,
		onChoose() { }
	}))

	// 一个 iframe，一个 message 监听。
	const frame = nodes.find((node) => node.type === 'iframe')
	assert.ok(frame !== undefined, '详情就绪的卡必须挂上预览 iframe')
	assert.equal(listeners.length, 1, '恰好挂一个 window message 监听')
	assert.equal(listeners[0].name, 'message')

	// 让这个 iframe 有一个自己的 window —— 真实浏览器里 contentWindow 就是它。
	frame.contentWindow = { name: 'this-iframe' }
	const handler = listeners[0].fn

	// 「量到的逻辑高度」是卡片的第三个 useState（前两个是 hover 与 inView）。
	const measured = react.states.find((slot) => slot.value === 0)
	assert.ok(measured !== undefined, '找不到 measuredHeight 那个状态槽')

	// 合法的消息：认领，并把高度写进状态。
	handler({ source: frame.contentWindow, origin: 'null', data: { type: exports.PREVIEW_MESSAGE_TYPE, height: 620 } })
	assert.equal(measured.value, 620, '合法的预览高度必须被认领')

	// 伪造的来源：不认，状态不动。
	handler({ source: { name: 'someone-else' }, origin: 'null', data: { type: exports.PREVIEW_MESSAGE_TYPE, height: 999 } })
	assert.equal(measured.value, 620, '不是这个 iframe 发来的消息必须被丢掉')

	// 非法高度：不认。
	handler({ source: frame.contentWindow, data: { type: exports.PREVIEW_MESSAGE_TYPE, height: '999' } })
	assert.equal(measured.value, 620, '非法 height 必须被丢掉')

	// 类型不对：不认。
	handler({ source: frame.contentWindow, data: { type: 'dsh:whatever', height: 999 } })
	assert.equal(measured.value, 620, '不认识的消息类型必须被丢掉')

	// 完全不相关的消息（别的窗口发的 null）不能让 handler 抛异常。
	handler({ source: { name: 'other' }, data: null })

	// 清理：卡片卸载时监听必须被摘掉，否则窗口上的监听会越积越多。
	assert.equal(react.cleanups.length, 1, '预览的 message 监听必须交回一个清理函数')
	react.cleanups[0]()
	assert.equal(listeners.length, 0, '清理之后 window 上不该还剩 message 监听')
})

test('预览高度跟着内容走，量不到时退回 16:10 且不塌', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)

	// 1. 兜底：vm 里没有 postMessage，量的永远是 0 —— 这时用 16:10 的比例。
	//    列宽 225（面板 712 / 三列 14 间距）时的算术：
	//      预览内容宽 = 225 − 2×8（卡片内边距）− 2×1（卡片描边）− 2×2（预览框描边）= 203
	//      scale = 203 / 480 ≈ 0.4229
	//      显示高度 = round(300 × 0.4229) = 127
	const template = {
		id: 'pomodoro', category: 'timer', icon: '🍅',
		zh: { name: '番茄钟', prompt: '一个番茄钟' }, en: { name: 'Pomodoro', prompt: 'x' }
	}
	const card = (props) => renderTree(exports.MiniAppTemplateCard(Object.assign({
		t: (key) => key, mode: { requestDetail() { } }, sessionId: 's1', template,
		face: exports.templateFace(template, 'zh'), detail: { status: 'ready', html: '<html></html>' },
		selected: false, viewport: null, cardWidth: 225, onChoose() { }
	}, props)))

	const fallback = card({})
	const fallbackFrame = fallback.find((node) => node.type === 'iframe')
	const fallbackPreview = fallback.find(
		(node) => node.props.style && node.props.style.borderColor !== undefined && node.props.style.height !== undefined
	)
	assert.ok(fallbackFrame !== undefined && fallbackPreview !== undefined, '预览必须存在')

	// iframe 自身用量到的逻辑高度（这里量不到 → 兜底的 16:10）。
	assert.equal(fallbackFrame.props.style.height, exports.PREVIEW_LOGICAL_HEIGHT)
	assert.equal(fallbackFrame.props.style.height, 300)
	assert.equal(fallbackFrame.props.style.width, exports.PREVIEW_LOGICAL_WIDTH)
	// 显示高度：有限、正数、且等于 16:10 缩放后的值 —— 量不到也**不能塌**。
	const height = fallbackPreview.props.style.height
	assert.equal(Number.isFinite(height) && height > 0, true, '量不到时预览高度必须是有限正数')
	assert.equal(height, 127, '兜底应当是 300 × (203/480) 四舍五入')
	assert.ok(height >= exports.PREVIEW_MIN_HEIGHT && height <= exports.PREVIEW_MAX_HEIGHT)
	// 缩放的锚点与系数：scale 必须等于 预览内容宽 / 逻辑宽。
	assert.equal(
		fallbackFrame.props.style.transform, 'scale(' + (203 / exports.PREVIEW_LOGICAL_WIDTH) + ')',
		'scale 必须跟着列宽走（203 = 225 − 内边距 − 两层描边）'
	)
	assert.equal(fallbackFrame.props.style.transformOrigin, '0 0')
	// 外层裁切：超长内容被 overflow:hidden 裁掉，而不是把卡片撑高。
	assert.equal(fallbackPreview.props.style.overflow, 'hidden')

	// 2. 逻辑高度 → 显示高度：夹在 [MIN, MAX] 之间。
	assert.equal(exports.previewDisplayHeight(300, 0.42), 126)
	assert.equal(
		exports.previewDisplayHeight(10, 0.42), exports.PREVIEW_MIN_HEIGHT,
		'极短内容不能缩成一条缝'
	)
	assert.equal(
		exports.previewDisplayHeight(5000, 0.42), exports.PREVIEW_MAX_HEIGHT,
		'超长内容不能占满整屏（外面还有十一张卡）'
	)
	assert.ok(exports.PREVIEW_MIN_HEIGHT > 0 && exports.PREVIEW_MIN_HEIGHT < exports.PREVIEW_MAX_HEIGHT)
	// 0 / NaN / 负数 逻辑高度 → 退回 16:10 的比例，永远给出有限正数。
	for (const degenerate of [0, -5, NaN, Infinity, undefined, null]) {
		const value = exports.previewDisplayHeight(degenerate, 0.42)
		assert.equal(Number.isFinite(value) && value > 0, true, `逻辑高度 ${String(degenerate)} 不能塌`)
	}

	// 3. iframe 自身的高度也有上限：比"能显示的那一块"更高的部分永远看不到，
	//    却要浏览器真按那个尺寸排一次版；而且模板若把高度写成相对视口，
	//    无上限时会出现"量到 → 改高度 → 量到更大"的一路膨胀。
	//    上限 = ceil(PREVIEW_MAX_HEIGHT / scale)；下面的兜底（300）远在它之下，所以不受影响。
	assert.equal(
		fallbackFrame.props.style.height, exports.PREVIEW_LOGICAL_HEIGHT,
		'兜底路径下 iframe 高度仍是 16:10 的逻辑高'
	)
	const cap = Math.ceil(exports.PREVIEW_MAX_HEIGHT / (203 / exports.PREVIEW_LOGICAL_WIDTH))
	assert.ok(cap > exports.PREVIEW_LOGICAL_HEIGHT, '封顶值必须高于兜底，否则兜底会被压扁')
	assert.ok(Number.isFinite(cap) && cap > 0)
	assert.ok(
		stripComments(readFileSync(clientPath, 'utf8')).includes('Math.min(logicalHeight, maxLogicalHeight)'),
		'iframe 高度必须封顶'
	)

	// 4. 卡片宽度还没量到（首帧）时退到 CARD_WIDTH，同样不塌。
	const firstFrame = card({ cardWidth: 0 })
	const firstFramePreview = firstFrame.find(
		(node) => node.props.style && node.props.style.borderColor !== undefined && node.props.style.height !== undefined
	)
	assert.equal(
		Number.isFinite(firstFramePreview.props.style.height) && firstFramePreview.props.style.height > 0, true,
		'首帧（还没量到列宽）也不能塌'
	)
})

test('卡片是「预览 + 名称 + 一句描述」：描述两行截断，不加徽章', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const { element } = createPanelFixture(exports)
	const nodes = renderTree(element)

	const prompt = '一个番茄钟：25 分钟专注 + 5 分钟休息，结束时提醒'
	const cards = nodes.filter((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined)

	// 每张卡一块面：底色、描边、圆角、内边距都在卡片自己身上。
	// （面板本体仍然透明 —— 那条有单独一条测试钉着。）
	for (const card of cards) {
		assert.equal(card.props.style.background, 'var(--dsw-alias-bg-layer-1)')
		assert.equal(card.props.style.borderRadius, 12)
		assert.equal(card.props.style.border, '1px solid var(--dsw-alias-border-l1)')
		assert.equal(card.props.style.padding, 8)
		// 卡片就是这三块，别加「HTML」「官方」这类徽章 —— 所有模板都是 HTML、都来自插件自己。
		assert.equal(card.children.filter((child) => child !== null && child !== undefined).length, 3)
	}

	// 描述：取自模板自带的 prompt（就是点卡片会写进输入框的那句话），两行截断。
	const described = cards.map((card) => card.children[2])
	assert.deepEqual(
		described.map((node) => textOf(node)),
		[prompt, '一个待办清单'],
		'描述要用 templateFace(...).prompt'
	)
	for (const node of described) {
		const style = node.props.style
		assert.equal(style.display, '-webkit-box', '多行截断必须走 -webkit-box')
		assert.equal(style.WebkitBoxOrient, 'vertical')
		assert.equal(style.WebkitLineClamp, 2, '描述截两行')
		assert.equal(style.overflow, 'hidden', '-webkit-line-clamp 必须配 overflow:hidden，否则第三行会漏出来')
		assert.equal(style.fontSize, 12)
		assert.equal(style.color, 'var(--dsw-alias-label-secondary)')
	}

	// 选中态：名称深色 + ✓，描述保持次要色（描述不该和名称抢注意力）。
	const selectedCard = cards.find((card) => card.props['aria-pressed'] === true)
	assert.ok(selectedCard !== undefined, 'fixture 里应当有一张选中的卡')
	assert.equal(selectedCard.children[1].props.style.color, 'var(--dsw-alias-label-primary)')
	assert.ok(
		renderTree(selectedCard.children[1]).some((node) => node.type === 'path' || node.type === 'svg'),
		'选中态要保留那个 ✓ 图标'
	)
	assert.equal(selectedCard.props.style.borderColor, 'var(--dsw-alias-brand-primary)', '选中只换描边颜色')
	const unselectedCard = cards.find((card) => card.props['aria-pressed'] === false)
	assert.equal(unselectedCard.props.style.borderColor, 'var(--dsw-alias-border-l1)')
	// 选中不改内边距/圆角：点一下不能把周围的内容挤动一格。
	assert.equal(unselectedCard.props.style.padding, selectedCard.props.style.padding)
	assert.equal(unselectedCard.props.style.borderRadius, selectedCard.props.style.borderRadius)
})

test('launcher 与 overlay 共享同一份状态，打开动作只有一个来源', () => {
	const { exports } = instantiateClientModule()
	const { ctx, registrations } = createFakeClientContext()
	exports.apply(ctx)

	const handles = registrations
		.filter((r) => r.options.name === 'sidebar.footer.action' || r.options.name === 'shell.overlay')
		.map((r) => r.options.inject().ui)
	assert.equal(handles.length, 2)
	assert.equal(handles[0], handles[1], '两个槽位必须共享同一个 ui 实例')

	let notifications = 0
	const unsubscribe = handles[0].subscribe(() => { notifications += 1 })
	assert.equal(handles[0].get().open, false)
	handles[1].set({ open: true })
	assert.equal(handles[0].get().open, true, '从任一侧打开都应当被另一侧看到')
	assert.equal(notifications, 1)
	unsubscribe()
	handles[0].set({ open: false })
	assert.equal(notifications, 1, '退订之后不该再收到通知')
})

// ------------------------------------------------------------------ 沙箱一致性

test('iframe 沙箱串与宿主半边逐字一致，且不含 allow-same-origin', () => {
	const code = stripComments(readFileSync(clientPath, 'utf8'))

	// 精确取常量值，而不是在整份源码里找子串：这份文件**必须**在给模型的提示词里
	// 提到 allow-same-origin（要告诉它运行环境没有这个授权、存储可能抛错），
	// 那是有意的文本，不是实现漏洞。真正不能出错的是这个常量本身。
	const match = /var IFRAME_SANDBOX = "([^"]*)"/.exec(code)
	assert.ok(match !== null, 'client.js 里找不到 IFRAME_SANDBOX 常量')
	const clientSandbox = match[1]

	assert.equal(
		clientSandbox,
		HOST_SANDBOX,
		`客户端沙箱串与宿主不一致：客户端 "${clientSandbox}" / 宿主 "${HOST_SANDBOX}"`
	)
	assert.ok(
		!clientSandbox.includes('allow-same-origin'),
		'IFRAME_SANDBOX 不得包含 allow-same-origin —— 与 allow-scripts 同时给出等于取消沙箱'
	)

	// 逐项检查授权串本身是合法的 sandbox 语法。
	const grants = clientSandbox.split(/\s+/)
	assert.equal(grants[0], 'allow-scripts')
	for (const grant of grants) {
		assert.match(grant, /^allow-[a-z-]+$/, `不是合法的沙箱授权项：${grant}`)
	}

	// 反过来：给模型的改造提示词必须**明确说出**没有 allow-same-origin，
	// 否则模型会写出依赖 localStorage 的应用。与 NomiFun 原版断言的正是同一条。
	for (const lang of ['zh', 'en']) {
		const marker = lang === 'zh' ? 'convertPrompt: "' : 'convertPrompt: "'
		const at = code.indexOf(marker)
		assert.ok(at >= 0, `找不到 ${lang} 的 convertPrompt`)
		const snippet = code.slice(at, at + 1200)
		assert.ok(
			snippet.includes('allow-same-origin'),
			`${lang} 的改造提示词必须告诉模型运行环境没有 allow-same-origin`
		)
	}
})

test('渲染逻辑不含可被静态发现的危险模式', () => {
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	// dangerouslySetInnerHTML 会把小程序内容当标记执行，这里一律不该出现。
	assert.ok(!code.includes('dangerouslySetInnerHTML'))
	// 小程序文档只经由 sandbox 过的 iframe 渲染。
	assert.ok(code.includes('sandbox: IFRAME_SANDBOX'))
	// document.write 同理：它会直接改写宿主页面。
	assert.ok(!code.includes('document.write'))

	// innerHTML 只允许出现在**一处**：把模块级常量 SVG 放进侧栏按钮。
	// 侧栏按钮走的是 DOM 注入（`sidebar.settings` 是 single 槽位），插的是我们
	// 自己写的图标，不经过任何渲染管道，也没有一个字节来自小程序或网络。
	// 但"唯一一处"这件事必须被锁住 —— 否则下一个顺手写 innerHTML 的人会拿到豁免。
	const assignments = [...code.matchAll(/\.innerHTML\s*=\s*([^;\n]+)/g)].map((match) => match[1].trim())
	assert.deepEqual(assignments, ['SIDEBAR_ICON_SVG'], 'innerHTML 只允许被赋成那一个常量')

	// 而且那个常量本身必须是纯字符串字面量拼出来的：一旦它带上变量，
	// 就重新变成了"把运行期数据当标记执行"的通道。
	const declaration = /var SIDEBAR_ICON_SVG = ([\s\S]*?);\n/.exec(code)
	assert.ok(declaration !== null, '找不到 SIDEBAR_ICON_SVG 常量')
	const withoutLiterals = declaration[1]
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
	assert.match(
		withoutLiterals,
		/^[\s+'"]*$/,
		`SIDEBAR_ICON_SVG 必须只由字符串字面量拼成，去掉字面量后还剩：${withoutLiterals.trim()}`
	)
})

// ------------------------------------------------------------------ 文案表

test('文案表双语完全对称，且注册成 DSH 要求的点分扁平键', () => {
	const { exports } = instantiateClientModule()
	const { ctx, locales } = createFakeClientContext()
	exports.apply(ctx)

	assert.equal(locales.length, 1, '只应注册一个文案命名空间')
	const [{ namespace, table }] = locales
	assert.equal(namespace, 'miniapp')
	assert.deepEqual(Object.keys(table).sort(), ['en', 'zh'])

	// 必须是扁平表。DSH 的查找是 `locales.get(locale)?.[key]`，
	// 一次直接属性访问、没有点分解析；留下嵌套对象就等于把键名显示给用户。
	for (const lang of Object.keys(table)) {
		const nested = Object.entries(table[lang]).filter(([, value]) => typeof value !== 'string')
		assert.deepEqual(
			nested.map(([key]) => key),
			[],
			`${lang} 表没有展平，这些键的值不是字符串`
		)
		assert.equal(typeof table[lang]['actions.open'], 'string', `${lang} 缺少点分扁平键 actions.open`)
	}

	const zh = Object.keys(table.zh).sort()
	const en = Object.keys(table.en).sort()
	assert.deepEqual(zh.filter((k) => !en.includes(k)), [], '英文缺少这些键')
	assert.deepEqual(en.filter((k) => !zh.includes(k)), [], '中文缺少这些键')
	assert.ok(zh.length >= 95, `展平后只有 ${zh.length} 个键，可能漏了整块`)
})

test('源码里每一个 t("…") 的键都能在两张表里查到', () => {
	// 这条是防「界面显示裸键名」的闸。它就是「按钮都是英文」那次事故的回归测试：
	// 当时表是嵌套的，lookup 找不到 key，于是把 actions.open 这样的键名直接画到了按钮上。
	const { exports } = instantiateClientModule()
	const { ctx, locales } = createFakeClientContext()
	exports.apply(ctx)
	const table = locales[0].table

	const code = stripComments(readFileSync(clientPath, 'utf8'))
	const staticKeys = new Set()
	for (const match of code.matchAll(/\bt\(\s*"([^"]+)"/g)) {
		const key = match[1]
		// 以 `.` 结尾的是动态前缀（`"import.rules." + copyKey + ".title"`），下面单独枚举。
		if (!key.endsWith('.')) staticKeys.add(key)
	}
	assert.ok(staticKeys.size >= 60, `只提取到 ${staticKeys.size} 个静态键，正则可能失效了`)

	const RULES = [
		'empty_payload', 'size_over_limit', 'not_html', 'fragment_not_document',
		'local_ref_unsupported', 'dev_server_ref', 'framework_source_entry',
		'server_template_markers', 'esm_bare_specifier', 'external_cdn_ref',
		'web_storage_use', 'nested_iframe_embed', 'unknown'
	]
	const SEVERITIES = ['fatal', 'autofix', 'warning']
	const dynamicKeys = [
		...RULES.flatMap((rule) => [`import.rules.${rule}.title`, `import.rules.${rule}.fix`]),
		...SEVERITIES.map((tier) => `import.severity.${tier}`),
		// 分类标签是 `t("templates.category." + item)` 拼出来的：认识的走文案表，
		// 不认识的回显原名。这里枚举"认识的那几个"，它们必须在两张表里都在。
		...['all', 'unknown', ...exports.TEMPLATE_CATEGORY_KEYS].map((name) => `templates.category.${name}`)
	]

	const missing = []
	for (const key of [...staticKeys, ...dynamicKeys]) {
		for (const lang of Object.keys(table)) {
			if (typeof table[lang][key] !== 'string') missing.push(`${lang}:${key}`)
		}
	}
	assert.deepEqual(missing, [], `这些键在界面上会显示成裸键名：${missing.join(', ')}`)
})

test('未知规则走 unknown 兜底而不是显示裸 id', () => {
	const { exports } = instantiateClientModule()
	const { ctx, locales } = createFakeClientContext()
	exports.apply(ctx)
	const table = locales[0].table
	for (const lang of Object.keys(table)) {
		// 兜底文案必须回显 ruleId，否则用户拿到一句无从下手的话。
		assert.ok(
			table[lang]['import.rules.unknown.title'].includes('{ruleId}'),
			`${lang} 的 unknown.title 必须回显 ruleId`
		)
		assert.equal(typeof table[lang]['import.rules.unknown.fix'], 'string')
	}
})


test('关键尺寸与原版一致（防止 UI 漂移）', () => {
	// 这些数字逐条抄自 nomifun-desktop 的
	// `pages/miniApps/index.tsx` / `RunnerPage.tsx` / `MiniAppFrame.tsx`。
	// 它们没有类型能保护 —— 谁顺手改一个圆角，界面就悄悄离开了"和原版一致"。
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	const must = [
		// 卡片：横向布局，44×44 图标块，14 圆角 / 14 内边距 / 12 间距
		['width: 44, height: 44', '卡片图标块 44×44'],
		['borderRadius: 12, background: T.fill', '图标块 12 圆角'],
		['padding: 14, borderRadius: 14', '卡片 14 内边距 / 14 圆角'],
		['display: "flex", gap: 12, overflow: "hidden"', '卡片横向布局 gap 12'],
		// 悬停：上移 2px + 阴影；动作组 26×26
		['translateY(-2px)', '卡片悬停上移'],
		['0 12px 30px rgba(0,0,0,0.12)', '卡片悬停阴影'],
		['width: 26, height: 26', '悬停动作 26×26'],
		['position: "absolute", top: 10, right: 10', '动作组锚在右上 10/10'],
		// 「打开使用」按钮
		['height: 24, padding: "0 9px", borderRadius: 8', '打开按钮 24 高 / 8 圆角'],
		// 网格列宽与间距
		['repeat(auto-fill, minmax(min(280px, 100%), 1fr))', '网格 280px 自适应列'],
		['display: "grid", gap: 14', '网格 gap 14'],
		// 标题与副标题
		['fontSize: 22, fontWeight: 600', '页面标题 22/600'],
		['maxWidth: 560, fontSize: 13, lineHeight: "19px"', '副标题 13/19 最大 560'],
		// 空态：72×72 圆形图标容器
		['width: 72, height: 72', '空态图标容器 72×72'],
		['padding: "64px 24px"', '空态内边距'],
		// 运行页：52px 工具栏 / 28×28 图标块 / 15px 700 标题
		['height: 52, padding: "0 16px"', '工具栏 52 高 / 16 内边距'],
		['width: 28, height: 28', '工具栏图标块 28×28'],
		['fontSize: 15, fontWeight: 700', '工具栏标题 15/700'],
		['width: 32, height: 32', '工具栏动作 32×32'],
		// 未发布横幅与看护条
		['padding: "6px 16px", background: tint(T.warn, 8)', '未发布横幅'],
		['left: 12, right: 12, bottom: 12', '看护条贴边 12'],
		['borderRadius: 10, padding: "8px 12px"', '看护条 10 圆角 / 8×12 内边距'],
		// 未发布胶囊
		['fontSize: 10, fontWeight: 600, lineHeight: "16px"', '未发布胶囊 10/600'],
		['borderRadius: 999, padding: "1px 6px"', '胶囊形状'],
	]
	const missing = must.filter(([needle]) => !code.includes(needle)).map(([, label]) => label)
	assert.deepEqual(missing, [], `这些尺寸已偏离原版：${missing.join('、')}`)
})

test('模板面板照 dsh-ppt：自己不上底，宽度与输入框逐像素对齐', () => {
	const code = stripComments(readFileSync(clientPath, 'utf8'))

	// 1. 面板不画底 —— 透明、无边框、无阴影、无圆角、无内边距。
	//    原来那块带阴影的白底读起来像"另一个浮层"，而不是输入框的延伸。
	assert.match(
		code,
		/padding: 0, border: 0, borderRadius: 0, boxShadow: "none", background: "transparent"/,
		'模板面板不该自己画底（PPT 的 templatePanel 是 background:0 0）'
	)

	// 2. 宽度用 DSH 自己的两个 composer 变量，而不是写死一个 760。
	//    根节点吃掉 side-clearance 的 padding，面板再按 100% 铺开，
	//    于是它的左右边缘正好落在输入框卡片的边缘上（实测卡片 712px ↔ 面板 712px）。
	assert.ok(
		code.includes('var(--dsh-composer-card-max-width, 744px)'),
		'面板宽度上限必须取自 --dsh-composer-card-max-width'
	)
	assert.ok(
		code.includes('var(--dsh-composer-side-clearance, 16px)'),
		'两侧留白必须取自 --dsh-composer-side-clearance'
	)
	assert.ok(!code.includes('maxWidth: 760'), '面板宽度不该再写死 760')
	assert.ok(
		code.includes('padding: "0 " + COMPOSER_CLEARANCE'),
		'根节点要让出 composer 的两侧留白，否则面板会比输入框宽出 32px'
	)

	// 3. 卡片走**三列瀑布流**（CSS 多列），不是固定 168px 居中 —— 固定宽度在窄窗口里
	//    两侧会参差；行对齐的栅格则做不出"卡片高度跟着内容走"的参考图效果。
	//
	//    **这条断言是本次有意的设计变更，理由**：参考图要的是高矮不一的卡片，
	//    `grid-template-columns: repeat(3, minmax(0,1fr))` 会把同一行的卡片拉成等高，
	//    做不到。换成 CSS 多列（`columns: 3` + `column-gap`）之后同一条公式仍然成立：
	//    列宽 = (容器宽 − gap × (列数−1)) / 列数。
	assert.match(
		code, /columns: PANEL_COLUMNS/,
		'模板栅格应为三列瀑布流（CSS 多列）'
	)
	assert.match(
		code, /columnGap: PANEL_GRID_GAP \+ "px"/,
		'列间距必须是 PANEL_GRID_GAP，否则列宽公式与实际列宽对不上'
	)
	assert.ok(
		!code.includes('gridTemplateColumns: "repeat(" + PANEL_COLUMNS'),
		'行对齐的三列栅格必须消失，否则同排卡片会被拉成等高'
	)
	assert.equal(PANEL_COUNT_IN_SOURCE(code), 4, 'PANEL_COLUMNS 必须是 4（对齐参考图的四列）')

	// 4. 预览边框粗细恒定：选中只换颜色，不换粗细 —— 否则点一下会把周围挤动一格。
	assert.ok(
		code.includes('border: "2px solid transparent"'),
		'预览边框必须恒为 2px 透明（选中只改 borderColor）'
	)
	assert.ok(
		code.includes('borderColor: selected ? T.brand : "transparent"'),
		'选中态应当只改边框颜色'
	)
	assert.ok(!code.includes('(selected ? 2 : 1) + "px solid "'), '旧的可变边框写法必须消失')

	// 5. 预览的缩放跟着列宽走，而不是一个常数。
	assert.ok(code.includes('transform: "scale(" + scale + ")"'), 'iframe 的缩放必须跟着列宽')
	assert.ok(!code.includes('PREVIEW_SCALE'), '缩放系数不该再是常量')

	// 6. 成功回执不能借错误横幅的颜色 —— "已经建好了"画成红色会让人先去找错。
	assert.ok(code.includes('var PANEL_NOTICE_STYLE'), '成功回执要有自己的样式')
	assert.match(
		code,
		/style: PANEL_NOTICE_STYLE, role: "status"/,
		'notice 必须走成功样式，而不是错误横幅'
	)
	assert.match(
		code,
		/PANEL_NOTICE_STYLE = \{[\s\S]{0,240}?tint\(T\.success, 40\)/,
		'成功回执应当是 success 色系'
	)
})

/** 从源码里读出 `var PANEL_COLUMNS = n;`。 */
function PANEL_COUNT_IN_SOURCE(code) {
	const match = /var PANEL_COLUMNS = (\d+);/.exec(code)
	return match === null ? null : Number(match[1])
}

test('搜索框与工具行按原版只在有内容时出现', () => {
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	// 原版：`!error && (apps.length > 0 || loading)` —— 首屏加载中不给搜索框。
	assert.ok(
		code.includes('props.error === null && (apps.length > 0 || props.loading)'),
		'工具行的显示条件已偏离原版'
	)
	assert.ok(code.includes('width: 200'), '搜索框应为 200px 宽（原版 w-200px）')
})

test('迭代提示词指导模型使用插件工具，而不是撞沙箱的 read/write', () => {
	const { exports } = instantiateClientModule()
	const { ctx, locales } = createFakeClientContext()
	exports.apply(ctx)

	for (const [lang, table] of Object.entries(locales[0].table)) {
		const prompt = table['iterate.prompt']
		assert.ok(prompt.includes('miniapp_read_source'), `${lang} 的迭代提示词没有提到 miniapp_read_source`)
		assert.ok(prompt.includes('miniapp_write_source'), `${lang} 的迭代提示词没有提到 miniapp_write_source`)
		assert.ok(prompt.includes('{path}'), `${lang} 的迭代提示词没有带上源码路径`)
		assert.ok(prompt.includes('{name}') && prompt.includes('{id}'), `${lang} 的迭代提示词缺少名称或 id`)
	}
})

// ------------------------------------- 会话页签 / 右侧抽屉 / 会话右上角浮窗

/** 沙箱授权串的**逐字**副本：新增的 iframe 也必须一字不差地用它。 */
const SANDBOX_LITERAL = 'allow-scripts allow-forms allow-popups allow-modals'

/**
 * 只够跑 RunnerView 那个看护定时器的 window 替身。
 *
 * 定时器只登记、不执行 —— 于是"挂上了一个看护"这件事是可观测的，
 * 而测试不会因为一个 6 秒的超时挂在半路上。
 */
function createTimerWindow() {
	const timers = new Map()
	let next = 0
	return {
		timers,
		setTimeout: (fn) => { next += 1; timers.set(next, fn); return next },
		clearTimeout: (handle) => { timers.delete(handle) },
		addEventListener() { },
		removeEventListener() { }
	}
}

/** 冲掉所有已经排队的微任务（fetch 替身 → callApi → 目录落地，要走好几跳）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** 一个"服务端答过"的目录快照。 */
const catalogApps = [
	{ miniapp_id: 'app-1', name: '番茄钟', icon: '🍅', has_unpublished_changes: false, updated_at: 1 },
	{ miniapp_id: 'app-2', name: '记账本', icon: '🧾', has_unpublished_changes: false, updated_at: 2 }
]

test('会话页签的登记参数：id / order / locale，并且 label 是一个会重读的函数', () => {
	// 一个**会真的查表**的 locale 面：label 是不是函数、切语言跟不跟着走，
	// 只有真的调用它两次才看得见（返回字符串那种写法两次都一样）。
	const makeContext = (table) => {
		const registrations = []
		return {
			registrations,
			ctx: {
				effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => undefined },
				locale: {
					register() { return () => undefined },
					bind() { return (key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key) }
				},
				slots: {
					inject(name, callback) { callback(); return () => undefined },
					register(options, component) { registrations.push({ options, component }); return () => undefined }
				}
			}
		}
	}

	const zh = makeContext({ 'view.tab': '小程序' })
	const { exports } = instantiateClientModule()
	exports.apply(zh.ctx)

	// 页签是按需登记的：先有一个会话把它用起来，才会出现这一格。
	exports.sessionViewStore.open('s1', 'app-1')
	exports.syncViewTab(zh.ctx)

	const view = zh.registrations.find((r) => r.options.name === 'conversation.view')
	assert.ok(view !== undefined, 'syncViewTab 没有登记会话页签')
	// list 座位：必须用**自己独有的 id**，否则就是替换别人的格子（replaceRisk: "none" 的前提）。
	assert.equal(view.options.id, 'miniapp')
	assert.equal(view.options.order, 20, 'order 20 排在 chat(0) 与 trajectory(10) 之后')
	assert.ok(view.options.order > 10, '不该排到 chat / trajectory 前面')
	assert.equal(view.options.locale, 'miniapp', '页签文字走自己的命名空间')
	assert.equal(view.component, exports.MiniAppSessionView, '页签的身体必须是那个会拉列表的组件')
	// label 必须**是函数**：DSH 每次投影页签都会重新读一遍（resolveSlotLabel(entry.options.label)），
	// 写成一个当场求值的字符串，切语言时页签文字就永远停在注册那一刻的语言上。
	assert.equal(typeof view.options.label, 'function', 'label 必须是函数（DSH 每次投影重读）')
	assert.equal(view.options.label(), '小程序')

	const en = makeContext({ 'view.tab': 'MiniApp' })
	const second = instantiateClientModule()
	second.exports.apply(en.ctx)
	second.exports.sessionViewStore.open('s1', 'app-1')
	second.exports.syncViewTab(en.ctx)
	const enView = en.registrations.find((r) => r.options.name === 'conversation.view')
	assert.equal(enView.options.label(), 'MiniApp', '英文界面下同一个函数返回英文')
	assert.equal(enView.options.id, view.options.id)
	assert.equal(enView.options.order, view.options.order)

	// 最硬的一条：**同一个注册**的 label 也要跟着语言走。它不是一个"注册那一刻求值的结果"，
	// 而是每次投影重读一次 —— 所以切语言根本不需要重新注册（这正是 DSH 文档里那句
	// "A thunk is re-read on every projection" 的落点）。
	const switching = { 'view.tab': '小程序' }
	const third = makeContext(switching)
	const thirdModule = instantiateClientModule()
	thirdModule.exports.apply(third.ctx)
	thirdModule.exports.sessionViewStore.open('s1', 'app-1')
	thirdModule.exports.syncViewTab(third.ctx)
	const thirdView = third.registrations.find((r) => r.options.name === 'conversation.view')
	assert.equal(thirdView.options.label(), '小程序')
	switching['view.tab'] = 'MiniApp'
	assert.equal(thirdView.options.label(), 'MiniApp', '同一个注册在切语言后必须给出新语言')
})

test('会话页签：没选中时画空态并从 /apps 拉列表，选中后在页签里跑同一个运行页', async () => {
	const requests = []
	const fetchStub = async (url) => {
		requests.push(String(url))
		return { ok: true, status: 200, json: async () => ({ ok: true, data: catalogApps }) }
	}
	const react = createEffectReact()
	const { exports } = instantiateClientModuleWith(react, {
		globals: { fetch: fetchStub },
		window: createTimerWindow()
	})
	const t = (key) => key

	// 1. 空态：必须**真的去拉列表**，而不是只写一句"请去面板"。
	const first = renderTree(exports.MiniAppSessionView({ t, sessionId: 's1' }))
	assert.deepEqual(requests, ['/plugins/dsh-miniapp/api/apps'], '空态必须自己去拉已发布的小程序')
	assert.equal(first.some((node) => node.children.includes('view.pick')), true, '空态要说清"选一个就在这儿跑"')
	await settle()
	assert.equal(exports.appCatalog.get().apps.length, 2, '拉回来的列表要进目录（三处运行面共用一份）')
	assert.equal(exports.appCatalog.get().loaded, true)

	// 2. 列表到位之后，空态是一列"名字 + 打开"，点一个就在这个页签里跑起来。
	const empty = renderTree(exports.MiniAppSessionView({ t, sessionId: 's1' }))
	const rows = empty.filter(
		(node) => node.type === 'button' && typeof node.props['aria-label'] === 'string'
			&& node.props['aria-label'].startsWith('actions.open')
	)
	assert.equal(rows.length, 2, '已发布的小程序要一条一行')
	assert.equal(textOf(empty).includes('番茄钟'), true, '名字要画出来')
	assert.equal(textOf(empty).includes('记账本'), true)
	// 列表已经在了，就不该再打一次后端。
	assert.deepEqual(requests, ['/plugins/dsh-miniapp/api/apps'])

	rows[0].props.onClick()
	assert.equal(exports.sessionViewStore.snapshot('s1').appId, 'app-1', '点「打开」要记住这个会话选了哪一个')
	assert.equal(exports.sessionViewStore.snapshot('s2').appId, null, '选中的小程序是会话的属性，不是全局开关')

	// 3. 选中之后：页签里跑的就是**同一个运行页组件** —— 同一个 iframe、同一条沙箱串、
	//    同一个 src（宿主直出已发布快照，不是 srcDoc）。
	const running = renderTree(exports.MiniAppSessionView({ t, sessionId: 's1' }))
	const frame = running.find((node) => node.type === 'iframe')
	assert.ok(frame !== undefined, '选中之后页签里必须挂上运行页的 iframe')
	assert.equal(frame.props.sandbox, SANDBOX_LITERAL, '沙箱串必须逐字不变')
	assert.equal(frame.props.sandbox, HOST_SANDBOX, '与宿主半边也必须一致')
	assert.equal(frame.props.src, '/plugins/dsh-miniapp/serve/app-1', '运行页必须走 SERVE 直出')
	assert.equal('srcDoc' in frame.props, false, '运行页不得改走 srcDoc')
	// 会话页签的高度由布局给，不需要文档自报 —— 所以**不带** ?embed=1。
	// 带上它只会让宿主多注入一段用不上的脚本（浮窗那一版才需要）。
	assert.equal(frame.props.src.includes('embed'), false, '只有浮窗那一版带 ?embed=1')

	// 4. 工具栏是**会话区那一档**：只有刷新 / 在浏览器中打开 / 关闭，
	//    没有「发布」「继续迭代」那两枚带文字的大按钮（这里是会话，不是浮层）。
	const toolLabels = running
		.filter((node) => node.props.role === 'button' && typeof node.props['aria-label'] === 'string')
		.map((node) => node.props['aria-label'])
		.sort()
	assert.deepEqual(toolLabels, ['actions.close', 'actions.openInBrowser', 'actions.refresh'])
	assert.equal(running.some((node) => node.props['data-action'] === 'create-now'), false)

	// 5. 「关闭」只是把这一格放空，不离开页签 —— 页签是会话的头，用户随手能切回来。
	const closeButton = running.find((node) => node.props['aria-label'] === 'actions.close')
	closeButton.props.onClick()
	assert.equal(exports.sessionViewStore.snapshot('s1').appId, null)
	assert.equal(renderTree(exports.MiniAppSessionView({ t, sessionId: 's1' }))
		.some((node) => node.children.includes('view.pick')), true, '关闭之后回到空态')
})

test('会话页签的选中态按会话分片，订阅粒度也是会话', () => {
	const { exports } = instantiateClientModule()
	const store = new exports.MiniAppSessionStore()

	// 没被碰过的会话拿到同一份初始快照（引用稳定，订阅者才不会空转）。
	assert.equal(store.snapshot('a'), store.snapshot('b'))
	assert.equal(store.snapshot('a').appId, null)

	const seenA = []
	const seenB = []
	const offA = store.subscribe('a', () => seenA.push(store.snapshot('a').appId))
	store.subscribe('b', () => seenB.push(store.snapshot('b').appId))

	store.open('a', 'app-1')
	assert.equal(store.snapshot('a').appId, 'app-1')
	assert.equal(store.snapshot('b').appId, null, '一个会话跑了小程序，不该影响另一个会话')
	assert.deepEqual(seenA, ['app-1'])
	assert.deepEqual(seenB, [], '另一个会话的订阅者不该被叫醒')

	// 同一个值不产生新快照：否则每次重开都会让整个页签白重渲染一次。
	const before = store.snapshot('a')
	store.open('a', 'app-1')
	assert.equal(store.snapshot('a'), before)
	assert.deepEqual(seenA, ['app-1'])

	// 脏输入既不写也不通知。
	for (const bad of ['', null, undefined, 42]) {
		store.open('a', bad)
		assert.equal(store.snapshot('a').appId, 'app-1', `appId=${String(bad)} 不该被写进状态`)
	}

	// 关闭回到空态；退订只影响这一个会话的那一个 listener。
	store.close('a')
	assert.equal(store.snapshot('a').appId, null)
	assert.deepEqual(seenA, ['app-1', null])
	const count = seenA.length
	offA()
	store.open('a', 'app-2')
	assert.equal(seenA.length, count, '退订之后不该再收到通知')
	assert.deepEqual(seenB, [])
})

test('切会话页签：靠点我们那一颗 tab（DSH 对页签没有 data-* 标识，只能按文字找）', () => {
	// 为什么是"点 tab"而不是调 DSH 的内部服务：页签的高亮与身体都取自会话 store 的
	// `view` 字段，写它的只有 `setView` / `openView`；它们只从 `conversation.session.header`
	// 的 `selectView` 进入 —— 而那个座位渲染子项时给的是**空 props**。
	// 内部服务那条（`uiConversation.binding(id).activate(view)`）落到 `activateTarget()`，
	// 它只往 activeTargets 加个名字，**不写 store**、不换身体也不高亮。
	// 页签自己的 onClick 走的是 `selectView` → `actions.setView`，那才是真的。
	// 给一个没注册过 view target 的名字调内部接口本身还有副作用，所以这里不调它。

	// 1. 没有 document（单测的 vm 里默认就是）：找不到页签 → false，绝不抛。
	const bare = instantiateClientModule()
	assert.equal(bare.exports.findSessionViewTab('小程序'), null)
	assert.equal(bare.exports.focusSessionViewTab('小程序'), false)
	assert.equal(bare.exports.focusSessionViewTab(''), false)
	assert.equal(bare.exports.focusSessionViewTab(null), false)
	assert.equal(bare.exports.focusSessionViewTab(undefined), false)

	// 2. 注入一个假 document：按文字找、排掉我们自己面板里的分类 tab、只点没选中的那一颗。
	const clicks = []
	const makeTab = (label, selected, inPanel) => ({
		textContent: label,
		getAttribute: (name) => (name === 'aria-selected' ? (selected ? 'true' : 'false') : null),
		click() { clicks.push(label) },
		closest: (selector) => (inPanel === true && selector === '[data-dsh-miniapp-panel]' ? {} : null)
	})
	const ourTab = makeTab('小程序', false, false)
	const panelTab = makeTab('小程序', false, true)   // 我们自己面板里的分类 tab 也叫 role=tab
	const alreadySelectedTab = makeTab('小程序', true, false)
	let tabs = [makeTab('会话', true, false), makeTab('轨迹', false, false), panelTab, ourTab]
	const fakeDocument = {
		querySelectorAll(selector) {
			assert.equal(selector, '[role="tablist"] [role="tab"]', '只查会话头部那一排页签')
			return tabs
		}
	}
	const scoped = instantiateClientModuleWith(createFakeReact(), { globals: { document: fakeDocument } })

	assert.equal(scoped.exports.findSessionViewTab('小程序'), ourTab, '应当找到会话头部那一颗，而不是面板里那颗')
	assert.equal(scoped.exports.findSessionViewTab('不存在'), null)
	assert.equal(scoped.exports.focusSessionViewTab('小程序'), true)
	assert.deepEqual(clicks, ['小程序'], '没选中的那一颗要被点一下')

	// 已经是当前页签时不再点（省掉一次没必要的 store 写入）。
	clicks.length = 0
	tabs = [makeTab('会话', false, false), alreadySelectedTab]
	assert.equal(scoped.exports.focusSessionViewTab('小程序'), true)
	assert.deepEqual(clicks, [], '已经是当前页签时不该再点')

	// 页签不在（空白会话的头部是隐藏的、或这个 DSH 改了页签 DOM）→ false，
	// 调用方必须把这件事说出来，而不是静默。
	tabs = [makeTab('会话', true, false), makeTab('轨迹', false, false)]
	assert.equal(scoped.exports.focusSessionViewTab('小程序'), false)

	// 3. `openInSession` 契约：先写选择，再切页签。顺序是有意的 —— 即使切不过去，
	//    用户手动点上方页签看到的也是他刚选的那一个，而不是空态。
	assert.equal(bare.exports.openInSession({}, 's1', 'app-1', '小程序'), false, 'vm 里没有 document，切不过去')
	assert.equal(bare.exports.sessionViewStore.snapshot('s1').appId, 'app-1', '但选择已经写进去了')
	assert.equal(bare.exports.openInSession({}, '', 'app-2', '小程序'), false)
	assert.equal(bare.exports.openInSession({}, 's3', '', '小程序'), false)
	assert.equal(bare.exports.sessionViewStore.snapshot('s3').appId, null, '脏输入既不写也不切')

	// 4. 当前会话 id 只能从 `sessions.list.getSnapshot().current` 取（ui-conversation 内部
	//    读的也是同一个字段），每一层都可能缺 —— 缺了就返回 null，由调用方说明。
	assert.equal(
		bare.exports.currentSessionId({ get: (n) => (n === 'sessions' ? { list: { getSnapshot: () => ({ current: 's1' }) } } : undefined) }),
		's1'
	)
	assert.equal(bare.exports.currentSessionId({ get: () => undefined }), null)
	assert.equal(bare.exports.currentSessionId({ get: () => ({ list: { getSnapshot: () => ({}) } }) }), null)
	assert.equal(bare.exports.currentSessionId({ get: () => ({ list: { getSnapshot: () => ({ current: '' }) } }) }), null)
	assert.equal(bare.exports.currentSessionId({ get: () => ({ list: { getSnapshot() { throw new Error('x') } } }) }), null)
	assert.equal(bare.exports.currentSessionId({ get() { throw new Error('x') } }), null)
	assert.equal(bare.exports.currentSessionId(undefined), null)
})

test('三个面互斥：打开一个就关掉另外两个（会话页签不受约束）', () => {
	const { exports } = instantiateClientModule()
	const { ctx, registrations } = createFakeClientContext()
	exports.apply(ctx)
	const handles = registrations
		.filter((r) => r.options.name === 'shell.overlay' || r.options.name === 'sidebar.footer.action')
		.map((r) => r.options.inject().ui)
	assert.equal(handles[0], handles[1], '两个座位仍然共享同一个 ui')

	const surfaces = () => [handles[0].get().open, handles[0].get().drawer, handles[0].get().corner]
	assert.deepEqual(plain(surfaces()), [false, false, false])

	handles[0].set({ open: true })
	assert.deepEqual(plain(surfaces()), [true, false, false])
	handles[0].set({ drawer: true, drawerId: 'app-1' })
	assert.deepEqual(plain(surfaces()), [false, true, false], '开右侧栏要关掉全屏浮层')
	assert.equal(handles[0].get().drawerId, 'app-1', '右侧栏要知道跑哪一个')
	handles[0].set({ corner: true, cornerId: 'app-2' })
	assert.deepEqual(plain(surfaces()), [false, false, true], '开浮窗要关掉右侧栏与全屏浮层')
	assert.equal(handles[0].get().cornerId, 'app-2')
	handles[0].set({ open: true })
	assert.deepEqual(plain(surfaces()), [true, false, false], '开回全屏浮层要关掉浮窗')

	// 关掉一个不会顺手打开别的；与浮层无关的状态变化也不该碰它们。
	handles[0].set({ drawer: false })
	assert.deepEqual(plain(surfaces()), [true, false, false])
	handles[1].set({ settingsInjected: true })
	assert.deepEqual(plain(surfaces()), [true, false, false])
	assert.equal(handles[0].get().settingsInjected, true, '既有的注入状态照旧共享')

	// 互斥不是"关掉页签"：会话页签是会话主体的一部分，没有开关，也不在互斥名单里。
	const source = stripComments(readFileSync(clientPath, 'utf8'))
	assert.match(source, /var SURFACE_KEYS = \["open", "drawer", "corner"\]/, '互斥名单里不该有会话页签')
})

test('右侧栏按需接管 details 并调用 layout：关掉时归还，且不去关不是自己开的列', () => {
	const { exports } = instantiateClientModule()
	const { ctx, registrations } = createFakeClientContext()
	const layoutCalls = []
	ctx.get = (name) => (name === 'layout'
		? { openDetails: () => layoutCalls.push('open'), closeDetails: () => layoutCalls.push('close') }
		: undefined)
	exports.apply(ctx)

	// 没打开过就 closeRightPanel：**不能**动那一列 —— 工具详情可能正开着，
	// 而 layout.closeDetails() 关的是 DSH 自己那一列，不看来源就会误伤。
	exports.closeRightPanel(ctx)
	assert.deepEqual(layoutCalls, [], '不是自己开的列，不该去关')

	// 打开：注册进 details（盖住工具详情）并让布局把列打开。
	exports.openRightPanel(ctx)
	assert.deepEqual(layoutCalls, ['open'])
	const panel = registrations.find((r) => r.options.name === 'details')
	assert.ok(panel !== undefined, 'openRightPanel 应当注册 details 座位')
	assert.equal(panel.options.name, 'details', '接管的就是布局里那一列，不是另开一列')
	assert.equal(typeof panel.component, 'function')
	// priority 必须低于 0：single 座位取 priority 最小的那个登记项渲染，
	// 工具详情的 DetailsPanel 是默认的 0 —— 同档或更高都永远轮不到我们，而且不报错。
	assert.equal(panel.options.priority, -10, '必须用负优先级盖住工具详情（DSH 的 subagent 也用 -10）')
	assert.ok(panel.options.priority < 0)
	// 再开一次不该注册第二遍（single 座位注册两次就是在自己盖自己）。
	exports.openRightPanel(ctx)
	assert.equal(registrations.filter((r) => r.options.name === 'details').length, 1, '不该重复注册')
	assert.deepEqual(layoutCalls, ['open', 'open'])

	// 关掉：撤销注册（DetailsPanel 自己回来）并关列。
	exports.closeRightPanel(ctx)
	assert.deepEqual(layoutCalls, ['open', 'open', 'close'])
	assert.equal(registrations.some((r) => r.options.name === 'details'), false, '关掉后要把列还给工具详情')

	// 没有 layout 服务的更老 DSH：注册照做，但不该抛。
	const bare = instantiateClientModule()
	const bareCtx = createFakeClientContext().ctx
	bareCtx.get = () => undefined
	bare.exports.apply(bareCtx)
	bare.exports.openRightPanel(bareCtx)
	bare.exports.closeRightPanel(bareCtx)
})

test('右侧栏与会话右上角浮窗：标记、几何、同一份运行页身体', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	exports.appCatalog.set({ apps: catalogApps, loading: false, error: null, loaded: true })
	const t = (key) => key

	// ---- 右侧栏：它是 DSH 布局里的**真列**（`details` 座位），不是浮层。
	// 所以它自己不定位、不画边框、不设 z-index —— 宽度由布局给，打开时**把会话挤窄**。
	const column = renderTree(exports.MiniAppFloatingRunner({ t, variant: 'column', appId: 'app-1', onClose() { } }))
	const columnRoot = column.find((node) => node.props['data-dsh-miniapp-right-panel'] !== undefined)
	assert.ok(columnRoot !== undefined, '右侧栏必须有 data-dsh-miniapp-right-panel 这个抓手')
	assert.equal(columnRoot.props['data-dsh-miniapp-corner'], undefined, '两种形态的标记不该同时出现')
	const columnStyle = columnRoot.props.style
	assert.equal(columnStyle.position, 'relative', '它是布局里的一列，不是 fixed 浮层')
	assert.equal(columnStyle.width, '100%')
	assert.equal(columnStyle.height, '100%')
	assert.equal(columnStyle.zIndex, 'auto', '布局列不该凌驾于整个界面之上')
	// 浮层那几条"自己定位"的痕迹一个都不该有 —— 有任何一个，它就又变成盖在会话上的抽屉了。
	for (const property of ['top', 'right', 'bottom', 'left', 'boxShadow', 'borderLeft', 'borderRadius']) {
		assert.equal(columnStyle[property], undefined, `右侧栏不该自己画 ${property}`)
	}

	// 头部：名字 + 在浏览器中打开 + 关闭。
	assert.equal(textOf(columnRoot).includes('番茄钟'), true, '头部要写出跑的是哪一个')
	const columnButtons = column
		.filter((node) => node.props.role === 'button' && typeof node.props['aria-label'] === 'string')
		.map((node) => node.props['aria-label'])
		.sort()
	assert.deepEqual(columnButtons, ['actions.close', 'actions.openInBrowser'])
	for (const node of column.filter((n) => n.props.role === 'button' && n.props['aria-label'] !== undefined)) {
		assert.equal(node.props.title, node.props['aria-label'], 'title 与 aria-label 都要设')
		assert.equal(node.props.tabIndex, 0, '头部也要键盘可达')
	}

	// 身体是同一个运行页组件，而且**不画第二条工具栏**（头已经有了）。
	const columnFrame = column.find((node) => node.type === 'iframe')
	assert.equal(columnFrame.props.sandbox, SANDBOX_LITERAL)
	assert.equal(columnFrame.props.src, '/plugins/dsh-miniapp/serve/app-1')
	assert.equal(
		column.some((node) => node.props.style !== undefined && node.props.style.height === 52), false,
		'右侧栏里不该再出现第二条 52px 工具栏 —— 头就是窗框'
	)

	// ---- 浮窗：锚**会话区**的右上角，一块有界的窗口。
	const corner = renderTree(exports.MiniAppFloatingRunner({ t, variant: 'corner', appId: 'app-1', onClose() { } }))
	const cornerRoot = corner.find((node) => node.props['data-dsh-miniapp-corner'] !== undefined)
	assert.ok(cornerRoot !== undefined, '浮窗必须有 data-dsh-miniapp-corner 这个抓手')
	assert.equal(cornerRoot.props['data-dsh-miniapp-right-panel'], undefined)
	const cornerStyle = cornerRoot.props.style
	assert.equal(cornerStyle.position, 'fixed')
	// 尺寸现在是**算出来的像素**（见 cornerWindowRect），不再是 CSS 的 min() 表达式：
	// 拖动与缩放都改的是这个数，而 CSS 表达式没法被指针事件改写。
	// vm 里没有 window → 视口量不到 → 退回默认的 380×420（与旧表达式同值）。
	assert.equal(cornerStyle.width, exports.CORNER_WIDTH)
	assert.equal(cornerStyle.height, exports.CORNER_HEIGHT)
	assert.equal(cornerStyle.bottom, undefined, '浮窗是有界的一块，不是通高')
	assert.equal(cornerStyle.borderRadius, 12)
	assert.ok(cornerStyle.zIndex < 50)
	// vm 里没有 document → 量不到会话区 → 退回窗口右上角的 12/12（换算成 left/top）。
	// 拖动之后 right 这种锚法就不合适了，所以定位统一成 left/top —— 见 cornerWindowRect。
	assert.equal(cornerStyle.left, exports.CORNER_GAP)
	assert.equal(cornerStyle.top, exports.CORNER_GAP)
	assert.equal(cornerStyle.right, undefined, '定位只留一套写法：拖动之后 right 不再有意义')
	assert.equal(corner.find((node) => node.type === 'iframe').props.sandbox, SANDBOX_LITERAL)

	// ---- 小程序不在时不能画一个空壳：给一句话，而且还能关掉。
	const missing = renderTree(exports.MiniAppFloatingRunner({ t, variant: 'corner', appId: 'nope', onClose() { } }))
	assert.equal(missing.some((node) => node.type === 'iframe'), false)
	assert.equal(missing.some((node) => node.props.role === 'status' && textOf(node).includes('open.missing')), true)
})

test('会话右上角浮窗的定位：按公式量出来，并且夹在窗口内', () => {
	const { exports } = instantiateClientModule()
	assert.equal(exports.CORNER_WIDTH, 380)
	assert.equal(exports.CORNER_HEIGHT, 420)
	assert.equal(exports.CORNER_GAP, 12)

	// top = 会话区顶边 + 12；right = 窗口宽 − 会话区右边 + 12。
	const size = exports.cornerWindowPosition({ top: 120, right: 1180 }, 1600, 900)
	assert.equal(size.top, 132)
	assert.equal(size.right, 432)

	// 夹在窗口内：会话区贴着窗口右边时，浮窗被拉回到"窗口宽 − 浮窗宽 − 12"。
	const clampedRight = exports.cornerWindowPosition({ top: 100, right: 200 }, 1600, 900)
	assert.equal(clampedRight.right, Math.round(1600 - Math.min(380, 1600 * 0.4) - 12))
	assert.equal(clampedRight.right, 1208)
	assert.equal(clampedRight.top, 112)
	// 会话区很靠下时，浮窗也不会探出窗口下边。
	const clampedTop = exports.cornerWindowPosition({ top: 880, right: 1180 }, 1600, 900)
	assert.equal(clampedTop.top, Math.round(900 - Math.min(420, 900 * 0.55) - 12))
	assert.equal(clampedTop.top, 468)

	// 量不到会话区（没有会话、DOM 还没挂上）→ 退回窗口右上角的 12/12。
	assert.deepEqual(plain(exports.cornerWindowPosition(null, 1600, 900)), { top: 12, right: 12 })
	assert.deepEqual(plain(exports.cornerWindowPosition(undefined, 1600, 900)), { top: 12, right: 12 })
	assert.deepEqual(plain(exports.cornerWindowPosition(null, undefined, undefined)), { top: 12, right: 12 })

	// 视口尺寸拿不到（测试的 vm、极早期的一次渲染）：不夹取，但仍然是有限值。
	const noViewport = exports.cornerWindowPosition({ top: 120, right: 1180 }, undefined, undefined)
	assert.equal(noViewport.top, 132)
	assert.equal(noViewport.right, 12, '没有视口宽就量不出"从右边到会话区"的距离，退回 12')

	// 脏 rect：字符串、NaN、空对象 —— 一律不能产出 NaN 或负坐标。
	for (const bad of [{ top: NaN, right: NaN }, { top: '100', right: '100' }, { top: Infinity, right: -Infinity }, {}]) {
		const position = exports.cornerWindowPosition(bad, 1600, 900)
		assert.ok(Number.isFinite(position.top) && position.top >= 12, `top 不合法：${JSON.stringify(plain(position))}`)
		assert.ok(Number.isFinite(position.right) && position.right >= 12, `right 不合法：${JSON.stringify(plain(position))}`)
	}
	// 极小窗口：夹取之后仍然是能看见的坐标（不会跑到屏幕外）。
	const tiny = exports.cornerWindowPosition({ top: 0, right: 100 }, 200, 150)
	assert.equal(tiny.top, 12)
	assert.equal(tiny.right, Math.round(200 - Math.min(380, 200 * 0.4) - 12))
	assert.ok(tiny.right >= 12)
})

test('浮窗按量到的会话区坐标定位（有 DOM 时走的是同一条公式）', () => {
	// 一个只认识那一个选择器的 DOM 替身：它顺便证明了浮窗**不是**从自己的节点往上找
	// 会话区（它在 shell.overlay 那一层，根本不在会话区里）。
	const scrollNode = { getBoundingClientRect: () => ({ top: 200, right: 1200, bottom: 900, left: 260 }) }
	const listeners = []
	const fakeDocument = {
		querySelector(selector) {
			if (selector === '[data-conversation-scroll]') return scrollNode
			throw new Error(`DOM 替身不认识这个选择器：${selector}`)
		}
	}
	const observers = []
	class FakeResizeObserver {
		constructor(callback) { this.callback = callback; this.target = null; this.connected = false; observers.push(this) }
		observe(node) { this.target = node; this.connected = true }
		disconnect() { this.connected = false }
	}
	const fakeWindow = {
		innerWidth: 1600,
		innerHeight: 900,
		addEventListener(name, fn) { listeners.push({ name, fn }) },
		removeEventListener(name, fn) {
			const at = listeners.findIndex((entry) => entry.name === name && entry.fn === fn)
			if (at >= 0) listeners.splice(at, 1)
		},
		setTimeout: () => 0,
		clearTimeout: () => undefined
	}

	const react = createEffectReact()
	const { exports } = instantiateClientModuleWith(react, {
		globals: { document: fakeDocument, ResizeObserver: FakeResizeObserver },
		window: fakeWindow
	})
	exports.appCatalog.set({ apps: catalogApps, loading: false, error: null, loaded: true })

	const nodes = renderTree(exports.MiniAppFloatingRunner({
		t: (key) => key, variant: 'corner', appId: 'app-1', onClose() { }
	}))
	const root = nodes.find((node) => node.props['data-dsh-miniapp-corner'] !== undefined)
	// 首帧就该落在量出来的位置上（初值就是量一次的结果，不会先闪一下窗口右上角）。
	// 坐标从"离右边 412"换算成 left：1600 − 412 − 380 = 808。
	assert.equal(root.props.style.top, 212, 'top = 200 + 12')
	assert.equal(root.props.style.left, 808, 'left = 1600 − (1600 − 1200 + 12) − 380')

	// 跟随：盯着会话区那个滚动容器，窗口尺寸变了也跟着。
	assert.equal(observers.length, 1, '要有一个 ResizeObserver 盯着会话区')
	assert.equal(observers[0].target, scrollNode)
	assert.equal(listeners.filter((entry) => entry.name === 'resize').length, 1, '还要跟窗口 resize')

	// 清理：两个跟随都要摘掉。
	assert.ok(react.cleanups.length >= 1)
	for (const cleanup of react.cleanups) cleanup()
	assert.equal(observers[0].connected, false, '清理必须断开 ResizeObserver')
	assert.equal(listeners.length, 0, '清理必须摘掉 resize 监听')
})

// ------------------------------------------------- 浮窗：拖动 / 缩放 / 自适应高度
//
// 这一组测的是新增的三件事（用户原话：「小程序在会话右上角悬浮打开时，支持鼠标
// 移动位置和调整大小，默认自适应高度」）。vm 里没有 DOM、PointerEvent 或
// ResizeObserver，所以：
//   * 几何算术全部走 client.js 里那几个**纯函数**（cornerDragTo / cornerResizeTo /
//     cornerClampRect / cornerAutoHeight / runnerHeightFromMessage），它们就是为了
//     能在没有浏览器的前提下被钉住才单独抽出来的；
//   * 组件那一层用假 document / 假 window / 假事件对象，验证"事件挂上了、写进了
//     同一份 ui、清理时又摘干净了"。

/** 会话区在 (top 200, right 1200)、视口 1600×900 下的一整套替身。 */
const CORNER_FIXTURE = {
	scrollTop: 200,
	scrollRight: 1200,
	viewportWidth: 1600,
	viewportHeight: 900
}

/** 默认角位下窗口的矩形：left = 1600 − (1600−1200+12) − 380 = 808，top = 212。 */
const CORNER_DEFAULT_RECT = { x: 808, y: 212, w: 380, h: 420 }

/**
 * 一个"跨多次渲染记状态"的 React 替身。
 *
 * `createEffectReact` 里那个 `useState` 每次渲染都从初值重建，于是"派一条事件 →
 * 再渲染一次看界面"根本测不出来：写进第一个渲染的那份槽位的值，第二次渲染看不见。
 * 拖动/缩放/量高这三件事都要走这条链路，所以这里按 hook 的**调用序号**记账，
 * 渲染之间保留值 —— 一个够用的最小实现，不需要 hook 位置校验。
 *
 * `useRef` 也记在同一个序列里，于是 ref 的身份跨渲染稳定（真实 React 就是如此）。
 * `useEffect` 每次渲染都执行，并把它带来的清理函数收进 `cleanups`；
 * 组件即将重新渲染时，真实 React 会先跑上一轮的清理，测试的 `render()` 也照做，
 * 否则同一个 window 上会挂着好几份旧监听器。
 */
function createStatefulReact() {
	const slots = []
	const cleanups = []
	/** 页面上那一个 iframe 的窗口对象（见 createElement 里的说明）。 */
	let frameWindow
	// 用闭包变量而不是 `this`：hooks 是被解构出来单独调用的（`const { useState } = React`），
	// 那时 `this` 根本不是这个对象。
	let cursor = 0
	const next = () => {
		const index = cursor
		cursor += 1
		return index
	}
	return {
		slots,
		cleanups,
		/** 每次"开始渲染"都要调一次：hook 的调用序号从头数。 */
		begin() {
			cursor = 0
			cleanups.splice(0).forEach((fn) => fn())
		},
		useState(initial) {
			const index = next()
			if (slots[index] === undefined) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
			return [slots[index].value, (value) => {
				slots[index].value = typeof value === 'function' ? value(slots[index].value) : value
			}]
		},
		useEffect(fn) {
			next()
			const cleanup = fn()
			if (typeof cleanup === 'function') cleanups.push(cleanup)
		},
		useLayoutEffect() { next() },
		useRef(initial) {
			const index = next()
			if (slots[index] === undefined) slots[index] = { current: initial }
			return slots[index]
		},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		createElement: (type, props, ...children) => {
			const node = { type, props: props ?? {}, children }
			// 假的 DOM 不会给 iframe 造一个真的 contentWindow，而"认领消息"靠的正是它。
			// 这里把**同一个**窗口对象绑到每个 iframe 节点上：认领比的是引用，
			// 所以它必须跨渲染稳定 —— 每次换一个新的，就变成"伪造 source"那一种形状了。
			if (type === 'iframe') {
				if (frameWindow === undefined) frameWindow = { name: 'runner-frame' }
				node.contentWindow = frameWindow
			}
			if (node.props.ref !== undefined && node.props.ref !== null) node.props.ref.current = node
			return node
		}
	}
}

/**
 * 一个"能有指针事件"的浮窗测试台。
 *
 * 与上面那条只读几何的测试共用同一套替身形状，但多两样东西：
 *  * `window` 上的 `addEventListener` 存进 `listeners` 数组，并且能 `dispatch`
 *    出事件 —— 拖动在没有 `setPointerCapture` 的环境里走的正是这条路；
 *  * `window` 上的 `message` 监听，用来喂量高消息。
 */
function createCornerHarness(options = {}) {
	const listeners = []
	const scrollNode = {
		getBoundingClientRect: () => ({
			top: CORNER_FIXTURE.scrollTop, right: CORNER_FIXTURE.scrollRight,
			bottom: 900, left: 260
		})
	}
	const fakeDocument = {
		querySelector(selector) {
			if (selector === '[data-conversation-scroll]') return scrollNode
			throw new Error(`DOM 替身不认识这个选择器：${selector}`)
		}
	}
	const observers = []
	class FakeResizeObserver {
		constructor(callback) { this.callback = callback; observers.push(this) }
		observe() { this.connected = true }
		disconnect() { this.connected = false }
	}
	const fakeWindow = {
		innerWidth: options.viewportWidth ?? CORNER_FIXTURE.viewportWidth,
		innerHeight: options.viewportHeight ?? CORNER_FIXTURE.viewportHeight,
		addEventListener(name, fn) { listeners.push({ name, fn }) },
		removeEventListener(name, fn) {
			const at = listeners.findIndex((entry) => entry.name === name && entry.fn === fn)
			if (at >= 0) listeners.splice(at, 1)
		},
		dispatch(name, event) {
			for (const entry of [...listeners]) if (entry.name === name) entry.fn(event)
		},
		setTimeout: () => 0,
		clearTimeout: () => undefined,
		open: () => undefined
	}
	const react = createStatefulReact()
	const { exports } = instantiateClientModuleWith(react, {
		globals: { document: fakeDocument, ResizeObserver: FakeResizeObserver },
		window: fakeWindow
	})
	exports.appCatalog.set({ apps: catalogApps, loading: false, error: null, loaded: true })

	const render = (variant) => {
		// 真实 React 在重渲染前会先跑上一轮的清理；这里照做，否则 window 上会
		// 越积越多份旧监听器，"清理有没有摘干净"就测不出来了。
		react.begin()
		return renderTree(exports.MiniAppFloatingRunner({
			t: (key) => key, variant: variant ?? 'corner', appId: 'app-1', onClose() { }
		}))
	}
	const rootOf = (nodes) => nodes.find((node) => node.props['data-dsh-miniapp-corner'] !== undefined)
	const headerOf = (nodes) => {
		const root = rootOf(nodes)
		return root.children.filter((child) => child !== null && typeof child === 'object')
			.find((child) => child.props !== undefined && child.props.style !== undefined
				&& child.props.style.height === 44)
	}
	const gripOf = (nodes) => nodes.find((node) => node.props['data-dsh-miniapp-corner-grip'] !== undefined)
	const iframeOf = (nodes) => nodes.find((node) => node.type === 'iframe')
	const countListeners = (name) => listeners.filter((entry) => entry.name === name).length
	return { exports, react, listeners, observers, fakeWindow, render, rootOf, headerOf, gripOf, iframeOf, countListeners }
}

/** 一个指针事件的替身：只有这几个字段是 client.js 真的读的。 */
function pointerEvent(node, x, y, extra = {}) {
	return Object.assign({
		currentTarget: node, clientX: x, clientY: y, pointerId: 7,
		preventDefault() { this.defaultPrevented = true },
		stopPropagation() { this.propagationStopped = true },
		releasePointerCapture() { this.released = true }
	}, extra)
}

test('浮窗几何纯函数：默认矩形、拖动、夹取、缩放、双击复位用的都是同一套', () => {
	const { exports } = instantiateClientModule()
	const vw = CORNER_FIXTURE.viewportWidth
	const vh = CORNER_FIXTURE.viewportHeight
	const scroll = { top: CORNER_FIXTURE.scrollTop, right: CORNER_FIXTURE.scrollRight }

	// 1. 默认（没拖过）：角位是量出来的，尺寸是默认的 380×420。
	assert.deepEqual(plain(exports.cornerDefaultSize(vw, vh)), { w: 380, h: 420 })
	assert.deepEqual(plain(exports.cornerDefaultSize(undefined, undefined)), { w: 380, h: 420 }, '量不到视口也要给有限值')
	assert.deepEqual(
		plain(exports.cornerWindowRect(scroll, vw, vh, null, null, undefined)),
		CORNER_DEFAULT_RECT
	)
	// 视口不同 → 默认尺寸跟着走（与旧的 CSS min() 表达式同值）。
	assert.deepEqual(plain(exports.cornerDefaultSize(800, 1000)), { w: 320, h: 420 })

	// 2. 位置：按**位移**更新，而不是按指针绝对坐标。
	const start = Object.assign({ pointerX: 900, pointerY: 300 }, CORNER_DEFAULT_RECT)
	assert.deepEqual(
		plain(exports.cornerDragTo(start, 800, 250, vw, vh)),
		{ x: 708, y: 162, w: 380, h: 420 },
		'往左上拖 (−100, −50) 就是原点加位移'
	)
	// 指针没动 → 位置不动（不会因为取整而漂移）。
	assert.deepEqual(plain(exports.cornerDragTo(start, 900, 300, vw, vh)), { x: 808, y: 212, w: 380, h: 420 })
	// 脏输入不产出 NaN：指针坐标非有限时按"没动"处理。
	assert.deepEqual(plain(exports.cornerDragTo(start, NaN, 'x', vw, vh)), { x: 808, y: 212, w: 380, h: 420 })

	// 3. 夹取：四个方向拖出视口，都要**完整留在视口内**。
	const drag = (px, py) => plain(exports.cornerDragTo(start, px, py, vw, vh))
	assert.deepEqual(drag(9999, 300), { x: vw - 380, y: 212, w: 380, h: 420 }, '往右拖：x 最大 vw − w')
	assert.deepEqual(drag(-9999, 300), { x: 0, y: 212, w: 380, h: 420 }, '往左拖：x 最小 0')
	assert.deepEqual(drag(900, -9999), { x: 808, y: 0, w: 380, h: 420 }, '往上拖：y 最小 0')
	assert.deepEqual(drag(900, 9999), { x: 808, y: vh - 420, w: 380, h: 420 }, '往下拖：y 最大 vh − h')
	// 四条边一起验一遍：夹取后窗口的两个角一定都落在视口里。
	for (const [px, py] of [[9999, 9999], [-9999, -9999], [9999, -9999], [-9999, 9999]]) {
		const rect = drag(px, py)
		assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= vw && rect.y + rect.h <= vh,
			`夹取之后必须完整可见：${JSON.stringify(rect)}`)
	}
	// 尺寸比视口还大时退回 0（0 让左上角——也就是拖动把手那一头——留在屏幕里）。
	const oversized = plain(exports.cornerClampRect({ x: 50, y: 50, w: 5000, h: 5000 }, 200, 150))
	assert.deepEqual(oversized, { x: 0, y: 0, w: 200, h: 150 }, '窗口不能比视口还大')
	// 视口只有一个方向拿不到时不夹那一维，但绝不产出 NaN。
	const half = plain(exports.cornerClampRect({ x: 10, y: 10, w: 380, h: 420 }, undefined, 900))
	assert.equal(half.x, 10, '拿不到视口宽就不夹 x')
	assert.equal(half.y, 10)
	// 脏 rect 一律给出有限值。
	for (const bad of [{ x: NaN, y: NaN, w: NaN, h: NaN }, { x: '1', y: '2', w: -5, h: -5 }, {}]) {
		const rect = plain(exports.cornerClampRect(bad, vw, vh))
		for (const key of ['x', 'y', 'w', 'h']) {
			assert.ok(Number.isFinite(rect[key]) && rect[key] >= 0, `${key} 不合法：${JSON.stringify(rect)}`)
		}
	}

	// 4. 缩放：右下角跟着指针走。
	const grip = Object.assign({ pointerX: 1188, pointerY: 632 }, CORNER_DEFAULT_RECT)
	assert.deepEqual(
		plain(exports.cornerResizeTo(grip, 1300, 800, vw, vh)),
		{ x: 808, y: 212, w: 492, h: 588 },
		'右下角拖到 (1300, 800)：宽 = 808→1300，高 = 212→800'
	)
	// 最小值：往回拖到极限也留得住 240×180。
	const shrunk = plain(exports.cornerResizeTo(grip, -9999, -9999, vw, vh))
	assert.deepEqual(shrunk, { x: 808, y: 212, w: exports.CORNER_MIN_WIDTH, h: exports.CORNER_MIN_HEIGHT })
	assert.equal(exports.CORNER_MIN_WIDTH, 240)
	assert.equal(exports.CORNER_MIN_HEIGHT, 180)
	// 最大值不超过视口，而且**位置要跟着收**：不然右下角那个手柄会被推到屏幕外，
	// 用户一松手就再也够不到它了。
	const grown = plain(exports.cornerResizeTo(grip, 1500, 890, vw, vh))
	assert.deepEqual(grown, { x: 808, y: 212, w: 692, h: 678 }, '手柄还在视口内：只长尺寸，位置不动')
	// 手柄被拖到**屏幕外**时位置才往回收：右边界贴住视口，手柄回到能碰到的地方。
	// 拖到屏幕之外：尺寸夹到视口本身，位置被收回 0（`x ≤ vw − w` 这时只剩 0 一个解），
	// 于是窗口完整可见 —— 手柄也就还在能碰到的地方。
	const overflowed = plain(exports.cornerResizeTo(grip, 9999, 9999, vw, vh))
	assert.deepEqual(overflowed, { x: 0, y: 0, w: vw, h: vh })
	assert.ok(overflowed.x + overflowed.w <= vw && overflowed.y + overflowed.h <= vh)
	for (const rect of [grown, overflowed]) {
		assert.ok(rect.x + rect.w <= vw && rect.y + rect.h <= vh, `缩放到极限也不能出屏：${JSON.stringify(rect)}`)
	}

	// 5. 用户拖过的位置与尺寸优先于角位与自适应高度。
	const dragged = plain(exports.cornerWindowRect(scroll, vw, vh, { x: 40, y: 60 }, { w: 300, h: 250 }, 700))
	assert.deepEqual(dragged, { x: 40, y: 60, w: 300, h: 250 }, '用户摆过的一律以他为准，内容高度不覆盖')
	// 只拖过位置、没动过尺寸：高度仍由内容说了算。
	assert.deepEqual(
		plain(exports.cornerWindowRect(scroll, vw, vh, { x: 40, y: 60 }, null, 700)),
		{ x: 40, y: 60, w: 380, h: 700 }
	)
	// 都没有 → 完全回到默认。
	assert.deepEqual(plain(exports.cornerWindowRect(scroll, vw, vh, null, null, undefined)), CORNER_DEFAULT_RECT)
})

test('自适应高度：只有浮窗那版 iframe 带 embed=1，两套消息协议互不认领', () => {
	const { exports } = instantiateClientModule()
	const vw = CORNER_FIXTURE.viewportWidth
	const vh = CORNER_FIXTURE.viewportHeight

	// ---- src 上的参数：只有浮窗那一版带。
	assert.equal(exports.EMBED_QUERY, 'embed=1')
	// 两侧字符串必须逐字一致：漂移的后果是**静默失效** —— 宿主不认识这个参数就
	// 不注入脚本，消息永远不来，浮窗只是安静地退回固定高度。
	assert.equal(exports.EMBED_QUERY, HOST_EMBED_QUERY, '客户端的 embed 参数必须与宿主半边逐字一致')
	assert.equal(HOST_EMBED_VALUE, '1')
	assert.equal(exports.cornerFrameUrl('app-1', false), '/plugins/dsh-miniapp/serve/app-1')
	assert.equal(exports.cornerFrameUrl('app-1', true), '/plugins/dsh-miniapp/serve/app-1?embed=1')
	assert.equal(exports.cornerFrameUrl('app-1', undefined), '/plugins/dsh-miniapp/serve/app-1', '默认不带')
	// id 照旧要 encodeURIComponent：参数不能吃掉 id 里的字符。
	assert.equal(exports.cornerFrameUrl('a/b', true), '/plugins/dsh-miniapp/serve/a%2Fb?embed=1')

	// ---- 消息协议：类型与宿主半边逐字一致，且与预览那套**不同**。
	assert.equal(exports.RUNNER_HEIGHT_MESSAGE_TYPE, HOST_RUNNER_HEIGHT_TYPE,
		'量高消息的类型必须与宿主注入脚本里那一个逐字一致')
	assert.notEqual(exports.RUNNER_HEIGHT_MESSAGE_TYPE, exports.PREVIEW_MESSAGE_TYPE,
		'两条 postMessage 通道不能共用一个类型名，否则会互相认领')
	assert.equal(exports.RUNNER_HEIGHT_MESSAGE_TYPE, 'dsh-miniapp:runner-height')

	// ---- 认领与校验。
	const frameWindow = { name: 'the-one-iframe' }
	const accept = (event) => exports.runnerHeightFromMessage(event, frameWindow)
	const TYPE = exports.RUNNER_HEIGHT_MESSAGE_TYPE
	assert.equal(accept({ source: frameWindow, data: { type: TYPE, height: 512 } }), 512)
	assert.equal(accept({ source: frameWindow, data: { type: TYPE, height: 512.4 } }), 513, '向上取整')

	// 伪造 source：页面上的第三方代码拿不到另一个窗口的引用，所以这一条是硬边界。
	assert.equal(accept({ source: { name: 'someone-else' }, data: { type: TYPE, height: 512 } }), 0)
	assert.equal(accept({ source: null, data: { type: TYPE, height: 512 } }), 0)
	assert.equal(exports.runnerHeightFromMessage({ source: frameWindow, data: { type: TYPE, height: 10 } }, null), 0)
	assert.equal(exports.runnerHeightFromMessage({ source: frameWindow, data: { type: TYPE, height: 10 } }, undefined), 0)

	// 非法的 height：字符串、NaN、Infinity、0、负数、缺字段，一律丢掉。
	for (const height of ['512', '1e999', NaN, Infinity, -Infinity, 0, -10, null, undefined, {}]) {
		assert.equal(accept({ source: frameWindow, data: { type: TYPE, height } }), 0,
			`非法的 height 必须丢掉：${String(height)}`)
	}
	// 类型不对（别人的消息、预览那套协议）也丢掉。
	assert.equal(accept({ source: frameWindow, data: { type: 'dsh-miniapp:preview-height', height: 512 } }), 0)
	assert.equal(accept({ source: frameWindow, data: { type: 'anything', height: 512 } }), 0)
	assert.equal(accept({ source: frameWindow, data: null }), 0)
	assert.equal(accept({ source: frameWindow, data: 'x' }), 0)
	assert.equal(accept(null), 0)
	assert.equal(accept(undefined), 0)
	// 两条通道确实互不认领：预览那条函数收到我们的消息也必须是 0。
	assert.equal(exports.previewHeightFromMessage({ source: frameWindow, data: { type: TYPE, height: 512 } }, frameWindow), 0)

	// ---- 高度夹取：clamp(round(h), 240, floor(vh * 0.8))。
	assert.equal(exports.CORNER_AUTO_MAX_RATIO, 0.8)
	assert.equal(exports.cornerAutoHeight(512, vh), 512)
	assert.equal(exports.cornerAutoHeight(512.6, vh), 513)
	assert.equal(exports.cornerAutoHeight(10, vh), 240, '太矮也要留出可用的一块')
	assert.equal(exports.cornerAutoHeight(99999, vh), Math.floor(vh * 0.8), '再高也不超过视口的 80%')
	assert.equal(exports.cornerAutoHeight(99999, vh), 720)
	// 量不到 → 0（调用方据此退回默认高度，绝不塌成 0 或 NaN）。
	for (const bad of [0, -1, NaN, Infinity, undefined, null, '512']) {
		assert.equal(exports.cornerAutoHeight(bad, vh), 0, `量不到就该返回 0：${String(bad)}`)
	}
	// 视口极小：上界低于下界时取上界 —— 比视口矮，而不是一条 240px 的"下限"。
	assert.equal(exports.cornerAutoHeight(1000, 250), 200)
	assert.ok(exports.cornerAutoHeight(1000, 250) < 250)
	// 视口高度量不到（测试的 vm）：上界退回默认高度，仍然是有限正数。
	assert.equal(exports.cornerAutoHeight(99999, undefined), 420)
})

test('头部里的按钮不能被拖动把手吞掉：按下交互控件时不起手拖动', () => {
	// 真机 bug：浮窗头部的「关闭」按不动。原因是头部既是拖动把手、又装着按钮，
	// 而 `pointerdown` 上的 `preventDefault()` 会抑制后续的**兼容鼠标事件**
	// （mousedown/mouseup/click）—— 于是按钮的 onClick 永远不触发。
	// 修法是起手前先看按到的是不是交互控件。这条测试钉住那个守卫。
	const harness = createCornerHarness()
	const { render, headerOf, exports } = harness
	const ui = exports.ui
	const header = headerOf(render())

	// 按在一个按钮上：不许起手（位置不变、没挂 window 监听、也没 preventDefault）。
	// pointerEvent 的第一个参数是 currentTarget，事件目标要放 extra.target。
	const buttonTarget = { closest: (selector) => (selector.includes('button') ? {} : null) }
	const onButton = pointerEvent(header, 900, 300, { target: buttonTarget })
	header.props.onPointerDown(onButton)
	// 没调用过 preventDefault 时这个字段是 undefined（不是 false），所以只能断言"不是 true"。
	assert.notEqual(onButton.defaultPrevented, true, '按在按钮上不该 preventDefault（那会吃掉 click）')
	assert.equal(harness.countListeners('pointermove'), 0, '按在按钮上不该挂拖动监听')
	const untouched = plain(ui.get().cornerPosition) ?? { x: 808, y: 212 }
	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, 400, 400))
	assert.deepEqual(plain(ui.get().cornerPosition) ?? { x: 808, y: 212 }, untouched, '按在按钮上不该能拖走窗口')

	// 按在空白处（真实元素但没有交互祖先）：照旧起手。
	const onBlank = pointerEvent(header, 900, 300, { target: { closest: () => null } })
	headerOf(render()).props.onPointerDown(onBlank)
	assert.equal(onBlank.defaultPrevented, true, '按在空白处才起手')
	assert.equal(harness.countListeners('pointermove'), 1)
	harness.fakeWindow.dispatch('pointerup', pointerEvent(null, 900, 300))
})

test('捕获路径必须有接收方：头部与缩放手柄都要挂 onPointerMove/Up/Cancel', () => {
	// 这条测试是从一个**真机 bug** 来的：`setPointerCapture` 成功之后代码直接 return，
	// 于是挂在 window 上的兜底监听从未被挂上；而捕获会把后续的 pointermove 重定向到
	// 头部元素 —— 那里没有 onPointerMove，事件就凭空消失了。
	// 表现是"能按下、窗口纹丝不动"，而 vm 里的假 DOM 没有 setPointerCapture，
	// 单元测试永远走的是那条能用的分支，所以它一路绿。
	//
	// 它教给我们一条：**凡是有两条互斥路径（捕获 / 兜底）的地方，要断言的是
	// "每条路径都有接收方"，而不是只测其中一条。**
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	exports.appCatalog.set({ apps: catalogApps, loading: false, error: null, loaded: true })

	const nodes = renderTree(exports.MiniAppFloatingRunner({
		t: (key) => key, variant: 'corner', appId: 'app-1', onClose() { }
	}))
	// t 在测试里是恒等函数，所以 title 是**键**而不是中文。
	const header = nodes.find((node) => node.props.title === 'corner.dragHint')
	assert.ok(header !== undefined, '找不到浮窗头部把手')
	assert.equal(typeof header.props.onPointerDown, 'function', '头部要有起手')
	assert.equal(typeof header.props.onPointerMove, 'function', '捕获之后的 pointermove 必须有人接')
	assert.equal(typeof header.props.onPointerUp, 'function')
	assert.equal(typeof header.props.onPointerCancel, 'function')

	const grip = nodes.find((node) => node.props['data-dsh-miniapp-corner-grip'] !== undefined)
	assert.ok(grip !== undefined, '找不到缩放手柄')
	assert.equal(typeof grip.props.onPointerDown, 'function')
	assert.equal(typeof grip.props.onPointerMove, 'function', '手柄捕获之后的 pointermove 必须有人接')
	assert.equal(typeof grip.props.onPointerUp, 'function')
	assert.equal(typeof grip.props.onPointerCancel, 'function')

	// 右侧栏那一版不该有把手（宽高由布局给）。
	const column = renderTree(exports.MiniAppFloatingRunner({
		t: (key) => key, variant: 'column', appId: 'app-1', onClose() { }
	}))
	assert.equal(column.some((node) => node.props['data-dsh-miniapp-corner-grip'] !== undefined), false)
})

test('拖动浮窗：头部是把手，位置写进同一份 ui，四个方向都夹在视口内', () => {
	const harness = createCornerHarness()
	const { exports, render, rootOf, headerOf } = harness
	const ui = exports.ui

	// ---- 头部那一行就是把手。
	const header = headerOf(render())
	assert.ok(header !== undefined, '浮窗的头部那一行必须存在')
	assert.equal(typeof header.props.onPointerDown, 'function', '头部要能接住 pointerdown')
	assert.equal(typeof header.props.onDoubleClick, 'function', '双击复位挂在同一行上')
	assert.equal(header.props.style.cursor, 'move', '光标要说明这一行能拖')
	assert.equal(header.props.style.touchAction, 'none', '触屏上按下-移动必须是拖动，不是滚动')
	assert.equal(header.props.title, 'corner.dragHint', 'title 给出「能拖」的提示')

	// ---- 起点 → 移动 → 位置按**位移**更新。
	// 起始矩形：left 808 / top 212（见 CORNER_DEFAULT_RECT）。
	const down = pointerEvent(header, 900, 300)
	header.props.onPointerDown(down)
	assert.equal(down.defaultPrevented, true, '拖动时要 preventDefault（别顺手选中文字）')
	// 这个 DOM 替身上没有 setPointerCapture → 走 window 兜底监听。
	assert.equal(harness.countListeners('pointermove'), 1, '没有 setPointerCapture 就挂到 window 上')
	assert.equal(harness.countListeners('pointerup'), 1)
	assert.equal(harness.countListeners('pointercancel'), 1)

	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, 800, 250))
	assert.deepEqual(plain(ui.get().cornerPosition), { x: 708, y: 162 }, '往左上拖 (−100, −50)')
	// 再移动一次：位移仍然是**相对按下那一刻**算的，不是相对上一次 move。
	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, 950, 320))
	assert.deepEqual(plain(ui.get().cornerPosition), { x: 858, y: 232 })

	// 渲染出来的是同一个数（left/top 由 ui 驱动）。
	const moved = rootOf(render())
	assert.equal(moved.props.style.left, 858)
	assert.equal(moved.props.style.top, 232)
	assert.equal(moved.props.style.right, undefined, '拖动之后 right 这种锚法不再出现')

	// ---- 结束：window 上的兜底监听必须全部摘掉。
	harness.fakeWindow.dispatch('pointerup', pointerEvent(null, 950, 320))
	assert.equal(harness.countListeners('pointermove'), 0, '松手要摘掉 pointermove')
	assert.equal(harness.countListeners('pointerup'), 0)
	assert.equal(harness.countListeners('pointercancel'), 0)
	// 松手之后再来 move 不该再改位置。
	const settled = plain(ui.get().cornerPosition)
	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, 10, 10))
	assert.deepEqual(plain(ui.get().cornerPosition), settled)

	// ---- 四个方向拖出视口，一律夹住。
	const dragTo = (x, y) => {
		ui.set({ cornerPosition: null })
		const start = headerOf(render())
		start.props.onPointerDown(pointerEvent(start, 1000, 500))
		harness.fakeWindow.dispatch('pointermove', pointerEvent(null, x, y))
		harness.fakeWindow.dispatch('pointerup', pointerEvent(null, x, y))
		return plain(ui.get().cornerPosition)
	}
	assert.deepEqual(dragTo(9999, 500), { x: 1220, y: 212 }, '往右拖：x = vw − w')
	assert.deepEqual(dragTo(-9999, 500), { x: 0, y: 212 }, '往左拖：x = 0')
	assert.deepEqual(dragTo(1000, -9999), { x: 808, y: 0 }, '往上拖：y = 0（角位是 212，位移是负的）')
	assert.deepEqual(dragTo(1000, 9999), { x: 808, y: 480 }, '往下拖：y = vh − h')

	// ---- 没有 setPointerCapture 时的退路已经是上面这条；有它时必须优先用它。
	const capturing = headerOf(render())
	const captured = []
	capturing.setPointerCapture = (id) => captured.push(id)
	capturing.props.onPointerDown(pointerEvent(capturing, 900, 300, { pointerId: 3 }))
	assert.deepEqual(captured, [3], '有 setPointerCapture 就优先用它')
	assert.equal(harness.countListeners('pointermove'), 0, '捕获成功就不该再挂 window 监听')
	// **捕获状态下的 move 必须真的由元素自己的 onPointerMove 接收。**
	// 这条以前是假绿：老代码把 onPointerMove 赋成 undefined 就"验完了"，而当时
	// 头部压根没挂 onPointerMove —— 真机上是"能按下、窗口纹丝不动"。所以要真的调它、
	// 并且断言位置真的动了。（变异审计把"换成空函数/换成别的 handler"标成三杀全绿。）
	const beforeCapture = plain(ui.get().cornerPosition) ?? { x: 808, y: 212 }
	// 往左上走（上一段刚好把窗口拖到了下边缘，再往下会被夹住，验不出位移）。
	capturing.props.onPointerMove(pointerEvent(capturing, 900 - 60, 300 - 40, { pointerId: 3 }))
	assert.deepEqual(plain(ui.get().cornerPosition), { x: beforeCapture.x - 60, y: beforeCapture.y - 40 },
		'捕获路径下的 pointermove 必须真的把窗口移动 (−60, −40)')
	capturing.props.onPointerUp(pointerEvent(capturing, 840, 260, { pointerId: 3 }))
	assert.equal(harness.countListeners('pointermove'), 0, '捕获路径收尾后也不该留下兜底监听')
	ui.set({ cornerPosition: null })

	// ---- 双击复位：位置与尺寸都回到默认（内容自报的高度重新说了算）。
	ui.set({ cornerPosition: { x: 40, y: 60 }, cornerSize: { w: 500, h: 300 } })
	const resettable = headerOf(render())
	resettable.props.onDoubleClick()
	assert.equal(ui.get().cornerPosition, null, '双击要把位置复位')
	assert.equal(ui.get().cornerSize, null, '双击要把尺寸复位（自适应高度随之回来）')
	const reset = rootOf(render())
	assert.equal(reset.props.style.left, CORNER_DEFAULT_RECT.x)
	assert.equal(reset.props.style.top, CORNER_DEFAULT_RECT.y)
	assert.equal(reset.props.style.width, CORNER_DEFAULT_RECT.w)
	assert.equal(reset.props.style.height, CORNER_DEFAULT_RECT.h)
})

test('缩放浮窗：右下角手柄改宽高，最小值/最大值夹取，但位置会跟着收', () => {
	const harness = createCornerHarness()
	const { exports, render, rootOf, gripOf } = harness
	const ui = exports.ui

	const grip = gripOf(render())
	assert.ok(grip !== undefined, '浮窗右下角必须有缩放手柄')
	assert.equal(grip.type, 'button')
	assert.equal(grip.props['aria-label'], 'corner.resize', '手柄要有名字（可见 + 无障碍）')
	assert.equal(grip.props.title, 'corner.resize')
	assert.equal(grip.props.tabIndex, 0, '手柄也要键盘可达')
	assert.equal(grip.props.style.cursor, 'nwse-resize')
	assert.equal(grip.props.style.position, 'absolute')
	assert.equal(grip.props.style.right, 0)
	assert.equal(grip.props.style.bottom, 0)
	assert.equal(grip.props.style.width, 14)
	assert.equal(grip.props.style.height, 14)
	assert.equal(grip.props.style.touchAction, 'none', '触屏上按住角标不能变成滚动')
	assert.equal(typeof grip.props.onPointerDown, 'function')

	// ---- 往右下拖：宽高一起长。
	grip.props.onPointerDown(pointerEvent(grip, 1188, 632))
	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, 1300, 800))
	assert.deepEqual(plain(ui.get().cornerSize), { w: 492, h: 588 })
	assert.deepEqual(plain(ui.get().cornerPosition), { x: 808, y: 212 }, '还放得下，位置不动')
	const bigger = rootOf(render())
	assert.equal(bigger.props.style.width, 492)
	assert.equal(bigger.props.style.height, 588)

	// ---- 松手：监听器摘干净，尺寸落位。
	harness.fakeWindow.dispatch('pointerup', pointerEvent(null, 1300, 800))
	assert.equal(harness.countListeners('pointermove'), 0)
	assert.equal(harness.countListeners('pointerup'), 0)

	// ---- 最小值：往回拖到极限也留得住 240×180。
	ui.set({ cornerSize: null, cornerPosition: null })
	const shrink = gripOf(render())
	shrink.props.onPointerDown(pointerEvent(shrink, 1188, 632))
	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, -9999, -9999))
	harness.fakeWindow.dispatch('pointerup', pointerEvent(null, -9999, -9999))
	assert.deepEqual(plain(ui.get().cornerSize), { w: exports.CORNER_MIN_WIDTH, h: exports.CORNER_MIN_HEIGHT })

	// ---- 最大值 + 位置跟着收：手柄拖到视口外，窗口往回收而不是探出去。
	ui.set({ cornerSize: null, cornerPosition: null })
	const grow = gripOf(render())
	grow.props.onPointerDown(pointerEvent(grow, 1188, 632))
	// 手柄拖到**屏幕外**：窗口往回收，位置跟着动，手柄不会被推出视口。
	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, 9999, 9999))
	const grown = plain(ui.get())
	assert.equal(grown.cornerSize.w + grown.cornerPosition.x, 1600, '右边界贴住视口，不探出去')
	assert.equal(grown.cornerSize.h + grown.cornerPosition.y, 900, '下边界同理')
	assert.deepEqual(grown.cornerSize, { w: 1600, h: 900 }, '最大值不超过视口')
	assert.deepEqual(grown.cornerPosition, { x: 0, y: 0 }, '位置跟着收，手柄不会被推出视口')
	harness.fakeWindow.dispatch('pointerup', pointerEvent(null, 9999, 9999))
	// 收尾之后仍然是同一份尺寸（不会弹回按下时的原点）—— 这正是曾经写错的那一处。
	assert.deepEqual(plain(ui.get().cornerSize), { w: 1600, h: 900 })

	// ---- 尺寸比视口还大（用户把浏览器缩得很窄）时退回 0：左上角留在屏幕里。
	harness.fakeWindow.innerWidth = 200
	harness.fakeWindow.innerHeight = 150

	ui.set({ cornerSize: null, cornerPosition: null })
	const tinyGrip = gripOf(render())
	tinyGrip.props.onPointerDown(pointerEvent(tinyGrip, 100, 100))
	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, 9999, 9999))
	harness.fakeWindow.dispatch('pointerup', pointerEvent(null, 9999, 9999))
	assert.deepEqual(plain(ui.get().cornerPosition), { x: 0, y: 0 })
	assert.deepEqual(plain(ui.get().cornerSize), { w: 200, h: 150 })
})

test('自适应高度：消息只被自己那个 iframe 认领，手动调过尺寸之后就不再覆盖', () => {
	const harness = createCornerHarness()
	const { exports, render, rootOf, iframeOf, countListeners, fakeWindow } = harness
	const ui = exports.ui

	// 第一次渲染：挂上 message 监听，iframe 是**浮窗那一版**（带 ?embed=1）。
	const first = render()
	assert.equal(countListeners('message'), 1, '浮窗要挂一个 message 监听收高度')
	const frameNode = iframeOf(first)
	assert.equal(frameNode.props.src, '/plugins/dsh-miniapp/serve/app-1?embed=1')
	// 这个 iframe 的窗口对象（React.createElement 的替身给它绑了一个稳定的）。
	const frameWindow = frameNode.contentWindow
	const frameRef = frameNode.props.ref
	assert.ok(frameRef !== undefined && frameRef !== null, '浮窗要把 iframe 的 ref 交出来（认领消息要用它）')
	assert.equal(frameRef.current, frameNode, 'ref 指向的就是这一个 iframe（认领比的是它的 contentWindow）')

	// ---- 认领：伪造 source 与非法 height 一律丢掉。
	const TYPE = exports.RUNNER_HEIGHT_MESSAGE_TYPE
	fakeWindow.dispatch('message', { source: { name: 'someone-else' }, data: { type: TYPE, height: 700 } })
	fakeWindow.dispatch('message', { source: frameWindow, data: { type: TYPE, height: '1e999' } })
	fakeWindow.dispatch('message', { source: frameWindow, data: { type: exports.PREVIEW_MESSAGE_TYPE, height: 700 } })
	fakeWindow.dispatch('message', { source: frameWindow, data: { type: TYPE, height: NaN } })
	let root = rootOf(render())
	assert.equal(root.props.style.height, 420, '一条都没认领 → 高度还是默认的 420')

	// ---- 认领成功：高度改成内容自报的值（宽度仍然 380，不跟内容走）。
	fakeWindow.dispatch('message', { source: frameWindow, data: { type: TYPE, height: 512 } })
	root = rootOf(render())
	assert.equal(root.props.style.height, 512)
	assert.equal(root.props.style.width, 380, '默认宽度不跟内容走')

	// 太矮 / 太高都被夹。
	fakeWindow.dispatch('message', { source: frameWindow, data: { type: TYPE, height: 40 } })
	assert.equal(rootOf(render()).props.style.height, exports.CORNER_AUTO_MIN_HEIGHT,
		'内容太矮 → 自适应下限 240（不是缩放手柄那个 180）')
	fakeWindow.dispatch('message', { source: frameWindow, data: { type: TYPE, height: 99999 } })
	assert.equal(rootOf(render()).props.style.height, 720, '再高也不超过视口的 80%')

	// ---- 用户手动拖过尺寸之后，消息不再覆盖他的尺寸。
	fakeWindow.dispatch('message', { source: frameWindow, data: { type: TYPE, height: 512 } })
	ui.set({ cornerSize: { w: 500, h: 300 }, cornerPosition: { x: 40, y: 60 } })
	fakeWindow.dispatch('message', { source: frameWindow, data: { type: TYPE, height: 700 } })
	root = rootOf(render())
	assert.equal(root.props.style.height, 300, '手动调过尺寸就以他为准')
	assert.equal(root.props.style.width, 500)

	// ---- 双击复位之后又回到自适应。
	ui.set({ cornerSize: null, cornerPosition: null })
	assert.equal(rootOf(render()).props.style.height, 700, '复位后内容自报的高度重新说了算')

	// ---- 右侧栏那一版：不带 ?embed=1，也不挂 message 监听、没有缩放手柄。
	const column = render('column')
	assert.equal(iframeOf(column).props.src, '/plugins/dsh-miniapp/serve/app-1', '右侧栏不带 embed 参数')
	assert.equal(column.some((node) => node.props['data-dsh-miniapp-corner-grip'] !== undefined), false,
		'右侧栏的宽高是布局给的，不该有缩放手柄')
	// 整个客户端里"传 embed"的地方**只有一处**，而且紧挨着 corner 这个判决。
	const code = stripComments(readFileSync(clientPath, 'utf8'))
	const embedUses = [...code.matchAll(/embed:\s*([A-Za-z0-9_.]+)/g)].map((match) => match[1])
	assert.deepEqual(embedUses, ['corner'], '只有浮窗那一版 iframe 带 ?embed=1')
})

test('浮窗的挂载与卸载：监听器都要摘掉，关掉浮窗不留一个挂在 window 上的把手', () => {
	const harness = createCornerHarness()
	const { exports, react, render, headerOf, countListeners, fakeWindow } = harness

	render()
	assert.equal(countListeners('resize'), 1, '跟随会话区/窗口尺寸')
	assert.equal(countListeners('message'), 1, '收量高消息')
	// 开一次拖动但不松手 —— 模拟"拖到一半浮层被关掉"。
	const header = headerOf(render())
	header.props.onPointerDown(pointerEvent(header, 900, 300))
	assert.equal(countListeners('pointermove'), 1)
	assert.ok(react.cleanups.length >= 3, '跟随、消息、手势收尾各自要有清理')

	// 卸载：所有监听器一个不剩。
	for (const cleanup of react.cleanups) cleanup()
	assert.equal(countListeners('resize'), 0, '清理必须摘掉 resize 监听')
	assert.equal(countListeners('message'), 0, '清理必须摘掉 message 监听')
	assert.equal(countListeners('pointermove'), 0, '手势没结束时也要把兜底监听摘掉')
	assert.equal(countListeners('pointerup'), 0)
	assert.equal(countListeners('pointercancel'), 0)
	assert.equal(harness.listeners.length, 0, 'window 上不该残留任何监听')

	// 摘掉之后再拖一下：没有监听器在跑，位置不动，也不抛。
	const before = plain(exports.ui.get().cornerPosition)
	fakeWindow.dispatch('pointermove', pointerEvent(null, 10, 10))
	assert.deepEqual(plain(exports.ui.get().cornerPosition), before)

	// 位置活在**模块级**的 ui 上：关掉浮层（组件卸载）之后再打开，位置还在。
	// 用一次真的拖拽把它写进去 —— 直接 `ui.set` 的话，组件读到的是它挂载时
	// 订阅到的那份快照（真实 React 会重渲染，这里的替身不会），测不出真实链路。
	const reopen = harness.headerOf(render())
	reopen.props.onPointerDown(pointerEvent(reopen, 1000, 500))
	harness.fakeWindow.dispatch('pointermove', pointerEvent(null, 900, 450))
	harness.fakeWindow.dispatch('pointerup', pointerEvent(null, 900, 450))
	assert.deepEqual(plain(exports.ui.get().cornerPosition), { x: 708, y: 162 }, '位置落在模块级 ui 上')
	const again = harness.rootOf(render())
	assert.equal(again.props.style.left, 708, '重新挂载之后位置还在，不必重摆')
	assert.equal(again.props.style.top, 162)
})

test('三个浮层共用一个渲染口：同时最多只有一个在跑，且提示活在浮层关闭之后', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const { ctx, registrations } = createFakeClientContext()
	exports.apply(ctx)
	exports.appCatalog.set({ apps: catalogApps, loading: false, error: null, loaded: true })

	const seat = registrations.find((r) => r.options.name === 'shell.overlay')
	const { ui } = seat.options.inject()
	const t = (key) => key
	// 用**注册进去的那一个组件**渲染：这条测试要覆盖的正是 DSH 实际挂上的东西。
	const render = (patch) => {
		ui.set(patch)
		return renderTree(seat.component({ ui, ctx, t }))
	}
	const markers = (nodes) => ({
		overlay: nodes.some((node) => node.props.style !== undefined && node.props.style.inset === 0 && node.props.style.zIndex === 50),
		// 右侧栏是布局里的真列，由 `details` 座位画 —— 这个渲染口**不该**画它。
		// 这条断言就是"它不再是抽屉"的机器化表达。
		column: nodes.some((node) => node.props['data-dsh-miniapp-right-panel'] !== undefined),
		corner: nodes.some((node) => node.props['data-dsh-miniapp-corner'] !== undefined),
		frames: nodes.filter((node) => node.type === 'iframe').length
	})

	// 都关着：什么都不画。
	const idle = markers(render({ open: false, drawer: false, corner: false }))
	assert.deepEqual(idle, { overlay: false, column: false, corner: false, frames: 0 })

	const overlay = markers(render({ open: true }))
	assert.equal(overlay.overlay, true)
	assert.equal(overlay.column || overlay.corner, false)

	// 开右侧栏：这个渲染口一个节点都不该多画（列在别处，由布局安排宽度）。
	const column = markers(render({ drawer: true, drawerId: 'app-1' }))
	assert.equal(column.column, false, '右侧栏不该由浮层渲染口画出来 —— 它是布局里的一列')
	assert.equal(column.overlay || column.corner, false, '右侧栏与另外两个面不该同时渲染')

	const corner = markers(render({ corner: true, cornerId: 'app-2' }))
	assert.equal(corner.corner, true)
	assert.equal(corner.overlay || corner.column, false)
	// 同一时刻最多一个小程序在跑：每个面里最多一个 iframe。
	for (const drawn of [overlay, column, corner]) assert.ok(drawn.frames <= 1, '同一时刻不该有两个运行页')

	// 只有标记、没有 id 时不画空壳（那会是一个什么都跑不了的浮层）。
	const hollow = markers(render({ drawer: true, drawerId: null, corner: false, open: false }))
	assert.deepEqual(hollow, { overlay: false, column: false, corner: false, frames: 0 })

	// 提示挂在渲染口上而不是浮层内部：「已放到本会话页签」正是浮层关掉之后才要看的。
	const toast = render({ open: false, drawer: false, corner: false, toast: 'open.placed' })
	assert.equal(toast.some((node) => node.props.role === 'status' && textOf(node).includes('open.placed')), true,
		'浮层关掉之后那条提示仍然要画得出来')
})

test('浮层工具栏上有三枚「换个地方打开」：32×32、键盘可达、点的就是它们自己的位置', () => {
	const react = createFakeReact()
	const { exports } = instantiateClientModuleWith(react)
	const app = { miniapp_id: 'app-1', name: '番茄钟', icon: '🍅', has_unpublished_changes: false }
	const calls = []
	const nodes = renderTree(exports.RunnerView({
		t: (key) => key, app,
		onBack() { }, onRefresh() { }, onPublished() { }, onIterate() { }, onRename() { }, onDelete() { }, onClose() { },
		onOpenInSession: (target) => calls.push('session:' + target.miniapp_id),
		onOpenInDrawer: (target) => calls.push('column:' + target.miniapp_id),
		onOpenInCorner: (target) => calls.push('corner:' + target.miniapp_id)
	}))

	for (const [label, expected] of [
		['open.location.session', 'session:app-1'],
		['open.location.drawer', 'column:app-1'],
		['open.location.corner', 'corner:app-1']
	]) {
		const button = nodes.find((node) => node.props['aria-label'] === label)
		assert.ok(button !== undefined, `浮层工具栏上缺少 ${label} 这枚按钮`)
		assert.equal(button.props.title, label, 'title 与 aria-label 都要设')
		assert.equal(button.props.role, 'button')
		assert.equal(button.props.tabIndex, 0, '新按钮必须能被 Tab 到')
		// 与现有按钮同一套 32×32 图标动作。
		assert.equal(button.props.style.width, 32)
		assert.equal(button.props.style.height, 32)
		const existing = nodes.find((node) => node.props['aria-label'] === 'actions.openInBrowser')
		assert.deepEqual(plain(Object.keys(button.props.style).sort()), plain(Object.keys(existing.props.style).sort()),
			'新按钮的样式项要与现有工具栏按钮完全一致')
		button.props.onClick()
	}
	assert.deepEqual(calls, ['session:app-1', 'column:app-1', 'corner:app-1'])

	// 会话页签那一档没有这三枚 —— 页签自己就是"别的地方"，再放一遍没有对象。
	const compact = renderTree(exports.RunnerView({
		t: (key) => key, app, chrome: 'compact', onRefresh() { }, onPublished() { }, onClose() { }
	}))
	for (const label of ['open.location.session', 'open.location.drawer', 'open.location.corner']) {
		assert.equal(compact.some((node) => node.props['aria-label'] === label), false, `会话页签里不该有 ${label}`)
	}
})

test('新文案键在 zh/en 两张表里都有，而且每一个都真的被界面取用', () => {
	const { exports } = instantiateClientModule()
	const { ctx, locales } = createFakeClientContext()
	exports.apply(ctx)
	const table = locales[0].table
	const code = stripComments(readFileSync(clientPath, 'utf8'))

	const keys = [
		'view.tab', 'view.pick', 'view.empty',
		'open.location.session', 'open.location.drawer', 'open.location.corner',
		'open.placed', 'open.noSession', 'open.missing'
	]
	for (const key of keys) {
		for (const lang of ['zh', 'en']) {
			assert.equal(typeof table[lang][key], 'string', `${lang} 缺少 ${key}`)
			assert.ok(table[lang][key].length > 0, `${lang} 的 ${key} 是空的`)
		}
		// 两张表里都有还不够：没被 t("…") 取用的键只是两张表里的一行死字。
		assert.ok(code.includes(`t("${key}")`), `${key} 没有被界面取用`)
	}

	// 三个"在哪里打开"的名字必须互不相同，否则用户分不清点哪个。
	for (const lang of ['zh', 'en']) {
		const labels = ['open.location.session', 'open.location.drawer', 'open.location.corner'].map((key) => table[lang][key])
		assert.equal(new Set(labels).size, 3, `${lang} 的三个打开位置名字重了`)
	}
	// 页签文字与浮层标题不是同一个词：页签叫「小程序」，浮层标题仍叫「小程序」不合适吗？
	// 这里只钉住它们都存在且非空 —— 具体措辞是设计决定，不是契约。
	assert.equal(typeof table.zh['view.tab'], 'string')
	assert.equal(typeof table.en['view.tab'], 'string')
})

test('浮层自己会把 appId 变成记录：目录还没拉过时它拉一次，之后不再重复拉', async () => {
	const requests = []
	const fetchStub = async (url) => {
		requests.push(String(url))
		return { ok: true, status: 200, json: async () => ({ ok: true, data: catalogApps }) }
	}
	const react = createEffectReact()
	const { exports } = instantiateClientModuleWith(react, {
		globals: { fetch: fetchStub },
		window: createTimerWindow()
	})
	// 打开抽屉的那一刻全屏浮层被关掉了，而它那份列表是它自己的局部状态、跟着一起消失。
	// 所以浮层必须能自己把 appId 变成记录 —— 否则用户看到的是永远停在"正在加载…"的空壳。
	assert.equal(exports.appCatalog.get().loaded, false)
	const first = renderTree(exports.MiniAppFloatingRunner({
		t: (key) => key, variant: 'column', appId: 'app-1', onClose() { }
	}))
	assert.deepEqual(requests, ['/plugins/dsh-miniapp/api/apps'], '浮层要自己去拉目录')
	assert.equal(first.some((node) => node.type === 'iframe'), false, '记录还没到位时不该画一个空的 iframe')
	assert.equal(first.some((node) => node.props.role === 'status' && textOf(node).includes('list.loading')), true)

	await settle()
	assert.equal(exports.appCatalog.get().loaded, true)
	const second = renderTree(exports.MiniAppFloatingRunner({
		t: (key) => key, variant: 'column', appId: 'app-1', onClose() { }
	}))
	const frame = second.find((node) => node.type === 'iframe')
	assert.equal(frame.props.src, '/plugins/dsh-miniapp/serve/app-1')
	assert.equal(frame.props.sandbox, SANDBOX_LITERAL)
	assert.equal(textOf(second.find((node) => node.props['data-dsh-miniapp-right-panel'] !== undefined)).includes('番茄钟'), true)
	// 抽屉开开关关不该次次打后端：目录是模块级的一份。
	assert.deepEqual(requests, ['/plugins/dsh-miniapp/api/apps'])

	// 目录给不出这一条（比如它已经被删掉）：给一句话，而不是一个空壳。
	const gone = renderTree(exports.MiniAppFloatingRunner({
		t: (key) => key, variant: 'column', appId: 'app-ghost', onClose() { }
	}))
	assert.equal(gone.some((node) => node.type === 'iframe'), false)
	assert.equal(gone.some((node) => node.props.role === 'status' && textOf(node).includes('open.missing')), true)
})
