// dsh-miniapp — 读「已安装的那一份 DSH」的公共件。
//
// 两个消费者：
//   * `test/client.test.mjs` —— 座位 / 服务契约检查（槽位名、kind/scope、服务提供点、
//     被调用的方法），全部对着 asar 里的**真实声明**核，而不是对着我们自己的假替身；
//   * `test/host.test.mjs`   —— skill 注册契约 probe：把 asar 里**真实的** `@deepseek-ai/dsh-skill`
//     连同它的依赖闭包抽到临时目录、`import()` 真入口跑一遍 `register / list / get`。
//
// 为什么必须读 asar（而不是 npm 上的包、也不是 npx 缓存）：权威的只有"用户机器上正在跑的那一份"。
// 本项目吃过一次**搜错树**的亏 —— 有人搜 `~/.npm/_npx/**` 的缓存树，那里躺着另一个版本的同名包，
// 于是得出了与事实相反的结论（"服务名写错了"）。所以这里的每条输出都会写明
// **校验的是哪棵树、用哪条读通道**。
//
// 口径（哪些名字做断言、哪些只写文档）的**逐字留档**在
// `docs/design.zh-CN.md` 的「口径：哪些名字做断言，哪些只写文档」一节；
// `test/client.test.mjs` 文件头的「三句口径」与它同源。
//
// 运行环境的一个坑（实测，必须绕）：`pnpm test` 用的 node 是 DSH Desktop 自己的
// runtime-commands 私有 node，它的 `fs` 被包装 ——
//   `statSync(asar)` 给出 `size === 0 && isFile() === false`；
//   `readFileSync('/Applications/DSH Desktop.app/…')` 直接抛 `ENOENT … not found in /Applications/…`。
// 所以判"树在不在"**不能**用 statSync，而要走 "真的读进来"：先进程内读，失败退到**真进程** `cat`。
// 只跳过不吭声是最坏的结果（那次 `5 skipped / 0 failed` 一片绿就是这么来的）。

// 口径（② 不做断言 / ② 反转变异**预期绿** / ④ 由 **CP1** 与 **CP2′** 承担 / 偏离裁决的标注）
// 的逐字留档在 `test/client.test.mjs` 文件头「三句口径」一节。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 默认的树：macOS 上安装的那一份。`DSH_ASAR` 可以覆盖（变异实测就靠它）。 */
export const DEFAULT_ASAR_PATH = '/Applications/DSH Desktop.app/Contents/Resources/app.asar'

export function resolveAsarPath() {
	const fromEnv = process.env.DSH_ASAR
	return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : DEFAULT_ASAR_PATH
}

/**
 * 把 asar 的字节读进来 —— **两条通道**。
 *
 * 通道一（进程内 `readFileSync`）在普通 node 下最快；通道二（`cat`）是给被包装的 fs 用的。
 * 用了哪条会原样报出去：结论不能脱离"对哪棵树、用哪只眼睛看的"。
 */
export function readAsarBytes(path) {
	let firstError
	try {
		const bytes = readFileSync(path)
		if (bytes.length > 0) return { bytes, channel: 'fs.readFileSync（进程内）' }
		firstError = new Error('readFileSync 返回了 0 字节（fs 被包装过？）')
	} catch (error) {
		firstError = error
	}
	try {
		const bytes = execFileSync('cat', [path], { maxBuffer: 512 * 1024 * 1024 })
		if (bytes.length > 0) return { bytes, channel: 'child_process cat（进程内 fs 被包装时的备用通道）' }
	} catch (error) {
		throw new Error(
			`两条读通道都失败：进程内 ${String(firstError?.message ?? firstError)}；cat ${String(error?.message ?? error)}`
		)
	}
	throw new Error(`两条读通道都失败：${String(firstError?.message ?? firstError)}`)
}

/**
 * 扫描器的能力边界 —— 必须**写进输出**。
 *
 * 现在的实现是**全量**的：只用 asar 条目自带的 `size` 限定"这个文件到哪结束"，
 * 搜索一律在整份 buffer 上用 `indexOf`，**没有任何大小过滤**。
 * 之所以要专门声明一句：本项目的 `asargrep` 曾经带 `size < 3MB` 过滤，差点让
 * "幽灵座位名 0 命中"这个结论失去支撑 —— 后人看到"脚本说 0 匹配"，必须能立刻判断
 * 那是不是一个"脚本看不见大文件"的假象。
 */
export const FULL_SCAN_NOTE =
	'全量扫、无 size 上限：搜索在整份 asar buffer 上做 indexOf，只用条目自带的 size 限定区间'

/**
 * 打开 asar：一次读进内存 + 把 header 翻成"绝对偏移区间"表。
 *
 * 布局：`[4B pickle 头][4B headerSize][4B …][4B headerSize]`，header（JSON）从 offset 16 开始，
 * 数据从 `16 + headerSize` 起算，条目自带 `offset`（相对数据基址）与 `size`。
 */
export function openAsar(buffer) {
	const headerSize = buffer.readUInt32LE(12)
	const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8'))
	const base = 16 + headerSize
	const entries = []
	const walk = (node, prefix) => {
		for (const [name, value] of Object.entries(node.files ?? {})) {
			const entryPath = (prefix + '/' + name).replace(/^\//, '')
			if (value.files !== undefined) {
				walk(value, entryPath)
				continue
			}
			if (value.offset === undefined || value.size === undefined) continue
			const start = base + Number(value.offset)
			entries.push({ path: entryPath, start, end: start + Number(value.size) })
		}
	}
	walk(header, '')
	entries.sort((a, b) => a.start - b.start)
	return {
		buffer,
		entries,
		has(entryPath) {
			return entries.some((entry) => entry.path === entryPath)
		},
		entryOf(entryPath) {
			return entries.find((entry) => entry.path === entryPath)
		},
		/** 某个绝对偏移落在哪个文件里 —— 回答"这条声明出自哪个包"。 */
		entryAt(offset) {
			let low = 0
			let high = entries.length - 1
			while (low <= high) {
				const mid = (low + high) >> 1
				const entry = entries[mid]
				if (offset < entry.start) high = mid - 1
				else if (offset >= entry.end) low = mid + 1
				else return entry
			}
			return undefined
		},
		/** 在**一个具体条目**的字节范围里找字符串；找不到返回 -1。 */
		findIn(entry, needle, from = entry.start) {
			const at = buffer.indexOf(needle, from)
			return at >= 0 && at < entry.end ? at : -1
		},
		textOf(entry) {
			return buffer.subarray(entry.start, entry.end).toString('utf8')
		}
	}
}

/**
 * 装载 + 自检 + 给出一条**可打印的说明**。
 *
 * 返回 `{ asar, note }` 或 `{ error }`；调用方拿 `error` 去 `{ skip: reason }`，
 * 于是"没有 DSH"既不假红也不假绿。形状自检（条目数 ≥ 1000）是必需的：
 * 有一次它真的挡住了误读 —— 被包装的 fs 给出 0 字节时，`openAsar` 会抛在 header 解析上。
 */
export function loadAsar(path = resolveAsarPath()) {
	if (typeof path !== 'string' || path === '') return { error: '没有指定 asar 路径' }
	let read
	try {
		read = readAsarBytes(path)
	} catch (error) {
		return { error: `${path} 读不动：${String(error?.message ?? error)}` }
	}
	let asar
	try {
		asar = openAsar(read.bytes)
	} catch (error) {
		return { error: `${path} 的 asar 头解析失败：${String(error?.message ?? error)}` }
	}
	if (asar.entries.length < 1000) {
		return { error: `${path} 的形状不像一份 DSH asar（只解析出 ${asar.entries.length} 个条目）` }
	}
	return {
		asar,
		note: `[asar] 校验对象：${path}（${asar.entries.length} 个条目，${(asar.buffer.length / 1024 / 1024).toFixed(1)} MiB，读通道：${read.channel}）；${FULL_SCAN_NOTE}`
	}
}

/** 给 `test(..., { skip })` 用的一句话：跳过必须是**有原因的**跳过。 */
export function skipReason(error) {
	return (
		`跳过：${error}。这条检查校验的是"正在跑的那一份"契约，没有它就无法判断 —— ` +
		'既不报红也不报绿。要跑它：装上 DSH Desktop，或用 DSH_ASAR=<path/to/app.asar> 指定一份。'
	)
}

// ------------------------------------------------------------------ 依赖闭包抽取

/** 包入口的候选路径（按此顺序找）。刻意不依赖 vendor 的 package.json —— 见下。 */
const ENTRY_CONVENTIONS = ['lib/index.js', 'lib/index.mjs', 'index.js', 'index.mjs', 'lib/client.js']

/**
 * 读 vendor 的 `package.json` —— 但**不要指望它**。
 *
 * 实测：这份 asar 里 vendor 的 `package.json` 全都读不出合法 JSON（8/8 抽样全中），
 * 而且**只有两种形状**，都是 1 字节的边界错误、**内容本身完好**：
 *
 *   * **形状 A —— header 里的 `size` 少了 1 字节**（`dsh-skill` / `dsh-util-values` /
 *     `dsh-scope` / `dsh-brand`）：读到的是 `\n{…` 且少一个收尾 `}`，
 *     判据是**按 `size + 1` 读就能 `JSON.parse` 成功**。
 *   * **形状 B —— header 里的 `offset` 早了 1 字节**（`cordis` / `schemastery` /
 *     `cosmokit` / `dsh-tools`）：读到的是 `}{…`（开头多出前一个文件的尾字节），
 *     判据是**按 `offset + 1` 读就能 `JSON.parse` 成功**。
 *
 * 也就是说这是**打包器写入侧**的边界错误（与"读法"无关，也与 `@deepseek-ai/dsh-*`
 * 的 JS 载荷无关 —— JS 文件抽查 `node --check` 通过）。
 *
 * 因此本读取器**不依赖** vendor manifest：解析失败一律**降级到路径约定**
 * （`lib/index.js` / `index.js` / …），而不是让整条 probe 挂掉；能解析就用它
 * （尊重 `exports` / `main`）。这也正是"闭包抽取"能在这种 asar 上跑通的原因。
 */
function readPackageManifest(asar, packageName) {
	const entry = asar.entryOf(`node_modules/${packageName}/package.json`)
	if (entry === undefined) return undefined
	try {
		return JSON.parse(asar.textOf(entry))
	} catch {
		return undefined
	}
}

/** 一个包的入口文件（相对于 asar 根的路径）。 */
function resolvePackageEntry(asar, packageName) {
	const dir = `node_modules/${packageName}/`
	const manifest = readPackageManifest(asar, packageName)
	const candidates = []
	if (manifest !== undefined) {
		const root = manifest.exports?.['.']
		const fromExports = typeof root === 'string' ? root : root?.import ?? root?.default
		for (const candidate of [manifest.module, manifest.main, fromExports]) {
			if (typeof candidate === 'string') candidates.push(dir + candidate.replace(/^\.\//, ''))
		}
	}
	for (const candidate of ENTRY_CONVENTIONS) candidates.push(dir + candidate)
	for (const candidate of candidates) {
		if (asar.has(candidate)) return candidate
	}
	return undefined
}

/** 从一段 ESM/CJS 源码里抽 import/require 的目标；`node:` 与裸内置一律跳过。 */
function importSpecifiersOf(text) {
	const specs = []
	const patterns = [
		/\bfrom\s+["']([^"']+)["']/g,
		/\bimport\(\s*["']([^"']+)["']\s*\)/g,
		/\brequire\(\s*["']([^"']+)["']\s*\)/g
	]
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) specs.push(match[1])
	}
	return specs
}

function isBuiltin(spec) {
	return spec.startsWith('node:') || spec === 'fs' || spec === 'path' || spec === 'url' || spec === 'os' || spec === 'util' || spec === 'events' || spec === 'assert' || spec === 'stream' || spec === 'crypto' || spec === 'buffer' || spec === 'child_process'
}

function packageNameOf(spec) {
	return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

/** 在同包内解析相对引用（`./x.js` / `../y.js`），找不到就试补 `.js` / `/index.js`。 */
function resolveRelative(fromEntryPath, spec) {
	const baseDir = dirname(fromEntryPath)
	const joined = join(baseDir, spec).replace(/\\/g, '/')
	const candidates = [joined, `${joined}.js`, `${joined}/index.js`]
	return candidates
}

/**
 * 把 `packages`（含它们的**传递**依赖）从 asar 抽到 `destDir/node_modules/**`，返回
 * `Map<包名, 入口文件绝对路径>`。
 *
 * 为什么是"抽出来 import"而不是"直接读 asar 里的源码来跑"：node 不能从 asar 里 `import`，
 * 而这条 probe 的全部价值就在于跑**真实的那份实现与真实的 Context**（这正是 t9 的 F1 逃过
 * 155 条全绿的原因：单测只证明了"注册被调用"，缺 `source` 时依然全绿）。
 *
 * 只抽**入口文件与它们的相对引用**：不抽整棵 node_modules（那会是 173 MiB）。
 * 每个包另外补一份最小 `package.json`（`type: "module"`），让裸名解析与 ESM 都成立。
 */
export function extractPackageClosure(asar, packages, destDir) {
	const packageEntries = new Map()
	const packageManifests = new Map()
	const filesToWrite = new Map()
	const queue = [...packages]

	const enqueuePackage = (packageName) => {
		if (packageEntries.has(packageName) || queue.includes(packageName)) return
		queue.push(packageName)
	}
	const enqueueFile = (entryPath) => {
		if (filesToWrite.has(entryPath)) return
		const entry = asar.entryOf(entryPath)
		if (entry === undefined) return
		filesToWrite.set(entryPath, asar.textOf(entry))
	}

	while (queue.length > 0) {
		const packageName = queue.shift()
		if (packageEntries.has(packageName)) continue
		const entryPath = resolvePackageEntry(asar, packageName)
		if (entryPath === undefined) {
			throw new Error(
				`无法在 asar 里定位包 ${packageName} 的入口文件（试过 package.json 与 ${ENTRY_CONVENTIONS.join(' / ')}）—— ` +
					'厂商的目录布局变了，请重新推导这里的约定'
			)
		}
		packageEntries.set(packageName, entryPath)
		packageManifests.set(packageName, readPackageManifest(asar, packageName))

		const pending = [entryPath]
		while (pending.length > 0) {
			const current = pending.shift()
			if (filesToWrite.has(current)) continue
			enqueueFile(current)
			const text = filesToWrite.get(current) ?? ''
			for (const spec of importSpecifiersOf(text)) {
				if (isBuiltin(spec)) continue
				if (spec.startsWith('.')) {
					const resolved = resolveRelative(current, spec).find((candidate) => asar.has(candidate))
					if (resolved === undefined) {
						throw new Error(`${current} 引用了 ${spec}，但 asar 里找不到对应文件`)
					}
					if (!filesToWrite.has(resolved)) pending.push(resolved)
					continue
				}
				enqueuePackage(packageNameOf(spec))
			}
		}
	}

	for (const [entryPath, text] of filesToWrite) {
		const target = join(destDir, entryPath)
		mkdirSync(dirname(target), { recursive: true })
		writeFileSync(target, text)
	}
	for (const [packageName, entryPath] of packageEntries) {
		const manifest = packageManifests.get(packageName)
		const target = join(destDir, 'node_modules', packageName, 'package.json')
		if (manifest === undefined) {
			mkdirSync(dirname(target), { recursive: true })
			// 这份 asar 里**所有** vendor `package.json` 都读不出合法 JSON（实测 6/6：
			// 有的开头多一个 `}`、有的中途截断）——所以这里补一份最小的、但**必须带 `main`**：
			// 只写 `{name, type}` 的话 node 会按默认去包根找 `index.js`，而这些包的入口都在
			// `lib/` 下，于是拿到 `ERR_MODULE_NOT_FOUND`（第一版就是这么挂的）。
			// 不写 `exports`：那会把深路径引用一起关掉，而 vendor 内部是否用深路径我们不该假定。
			const relativeEntry = entryPath.slice(`node_modules/${packageName}/`.length)
			writeFileSync(target, JSON.stringify({
				name: packageName,
				type: 'module',
				main: relativeEntry
			}, null, 2))
		}
		packageEntries.set(packageName, join(destDir, entryPath))
	}
	return { entries: packageEntries, fileCount: filesToWrite.size, manifestFallback: packageManifests }
}

/** 供测试打印用：闭包抽取的摘要（抽了多少包、多少文件）。 */
export function describeClosure(closure) {
	return `闭包：${closure.entries.size} 个包 / ${closure.fileCount} 个文件`
}

export { pathToFileURL, fileURLToPath }
