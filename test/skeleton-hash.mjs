// dsh-miniapp — 骨架哈希工具：证明「这次改动只动了注释，代码一个字符都没变」。
//
// 为什么要有这件东西（口径第 10 条的自我应用）：
//   第 10 条宣布「**只存在于 /tmp 的东西不算证据**」，而这条规则最初就是这么立的 ——
//   它来自一次真实事故：verifier 与我各自算 `lib/client.js` 的"骨架哈希"，**两套实现、
//   两个规则、得到两个不同的数**，差一点被当成"树变了"。当时算锚的工具只在 /tmp 里，
//   第三方**无法独立复算**，只能各自重写一遍剥注释器 —— 于是同样的分歧随时会再来一次。
//   这件工具落进仓库，就是为了让「证明规则」与「证明工具」都进版本历史。
//
// 规则（**逐字，顺序是规则的一部分**）：
//
//   剥 `/*…*/` 与行尾 `//` 注释 → **每行 `trim`** → **丢掉 `trim` 之后为空的行**
//     → 以 `\n` 连接 → `sha256`
//
// 为什么顺序不能反（"先去空行再 trim"是不稳定的）：注释**占整行**时，剥完只剩前导空白，
// 那一行在"先去空行"里**不是空行**（还有空白字符），于是被留下、再 trim 成空串，最终
// 以空行形式进入骨架 —— 注释块一变长，骨架就跟着变，**纯注释改动会假报"代码变了"**。
// 实测：某次纯注释改动在该顺序下 `lib/client.js` 从 5228 行变到 5248 行、哈希不同（假红）。
//
// 等价性的正确论证：**同一规则施于两侧，相等才说明代码没动**。所以这份文件永远同时给
// **两侧**（before / after）的文件 md5、文件 sha1、总行数，以及骨架行数与骨架 sha256；
// 只给单侧哈希是"不可复现的数字"。
//
// 用法（一条命令复现链上三条锚）：
//
//   node test/skeleton-hash.mjs --anchors                        # 复算三条锚并与常量比对
//   node test/skeleton-hash.mjs --report <files…>                # 打印文件/骨架指纹（第 10 条补全版）
//   node test/skeleton-hash.mjs --compare <before> <after>       # 两侧骨架逐字节比对（纯注释变更用）
//   node test/skeleton-hash.mjs --comment-only <before> <after>  # 逐 hunk 断言：改动行都在注释里
//   node test/skeleton-hash.mjs --selftest                       # 只跑剥离器的自测
//
// 不带参数运行（或由 `node --test` 收集）时，本文件里的测试会照常跑 —— 它是"工具 + 自己的
// 测试"两用件，所以 `package.json` 的 test 脚本把它列进去了。
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(here, '..')

/** 正则字面量允许出现的"上一个有效字符"。 */
const REGEX_PRECEDERS = new Set([
	'(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'
])
/** 同上：这些关键字后面跟 `/` 是正则，不是除号。 */
const REGEX_KEYWORDS = [
	'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'case', 'yield', 'await'
]

function regexAllowed(last) {
	if (last === '') return true
	return REGEX_PRECEDERS.has(last) || REGEX_KEYWORDS.includes(last)
}

/**
 * 剥掉注释，返回**逐字对齐**的其余源码（换行与空白全部保留，注释原地删除）。
 *
 * 为什么要写词法剥离器而不是 `sed 's|//.*$||'` 那种土办法：这两个被测文件里
 *   * 字符串里有 `//`（URL、文案）；
 *   * 模板字面量里有整段 HTML，`${}` 里还允许再嵌注释；
 *   * 正则字面量里可以有 `\/` 与字符类里的 `/`。
 * 土办法会把它们当注释切掉 —— 于是"改前改后相同"可能只是一起被切错，属于**假绿**。
 */
export function stripComments(src) {
	const n = src.length
	let out = ''
	let i = 0
	let last = ''
	const push = (text) => { out += text }
	while (i < n) {
		const ch = src[i]
		// 行注释：吃到换行为止（换行本身留下，行号才不会错位）
		if (ch === '/' && src[i + 1] === '/') {
			while (i < n && src[i] !== '\n') i += 1
			continue
		}
		// 块注释
		if (ch === '/' && src[i + 1] === '*') {
			i += 2
			while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1
			i += 2
			continue
		}
		// 单/双引号字符串：`\` 转义必须整对搬走，否则 `'\\'` 会被当成未闭合
		if (ch === '"' || ch === "'") {
			const quote = ch
			push(ch)
			i += 1
			while (i < n) {
				if (src[i] === '\\') { push(src[i]); push(src[i + 1]); i += 2; continue }
				push(src[i])
				if (src[i] === quote) { i += 1; break }
				i += 1
			}
			last = 'literal'
			continue
		}
		// 模板字面量：`${ … }` 里可以再嵌字符串/注释/模板，所以按花括号深度走
		if (ch === '`') {
			push(ch)
			i += 1
			while (i < n) {
				if (src[i] === '\\') { push(src[i]); push(src[i + 1]); i += 2; continue }
				if (src[i] === '`') { push(src[i]); i += 1; break }
				if (src[i] === '$' && src[i + 1] === '{') {
					push('${')
					i += 2
					let depth = 1
					while (i < n && depth > 0) {
						if (src[i] === '{') depth += 1
						else if (src[i] === '}') depth -= 1
						if (depth === 0) { push('}'); i += 1; break }
						// `${}` 里面的注释不是模板正文，照常剥
						if (src[i] === '/' && src[i + 1] === '/') {
							while (i < n && src[i] !== '\n') i += 1
							continue
						}
						if (src[i] === '/' && src[i + 1] === '*') {
							i += 2
							while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1
							i += 2
							continue
						}
						push(src[i])
						i += 1
					}
					continue
				}
				push(src[i])
				i += 1
			}
			last = 'literal'
			continue
		}
		// 正则字面量：只有上一个有效符号允许时才当正则，否则是除号
		if (ch === '/' && regexAllowed(last)) {
			push(ch)
			i += 1
			let inClass = false
			while (i < n) {
				if (src[i] === '\\') { push(src[i]); push(src[i + 1]); i += 2; continue }
				if (src[i] === '[') inClass = true
				else if (src[i] === ']') inClass = false
				else if (src[i] === '/' && !inClass) { push(src[i]); i += 1; break }
				else if (src[i] === '\n') break // 未闭合：退回按除号处理，别把后面整段吃掉
				push(src[i])
				i += 1
			}
			last = 'literal'
			continue
		}
		push(ch)
		if (!/\s/.test(ch)) last = ch
		i += 1
	}
	return out
}

/**
 * 骨架（第 10 条规则）：剥注释 → **每行 trim** → **丢掉 trim 后为空的行** → `\n` 连接。
 *
 * 顺序写死在这里就是规则本身，别改成"先去空行再 trim"（理由见文件头）。
 */
export function skeleton(src) {
	return stripComments(src)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.join('\n')
}

const hash = (text, algo) => createHash(algo).update(text, 'utf8').digest('hex')

/** 与 `wc -l` 同一口径：数换行符（文件末尾那个换行也算一行结束，但不额外多一行）。 */
export const countLines = (src) => (src.match(/\n/g) ?? []).length

/** 第 10 条补全版要的那几个量：文件 md5/sha1、总行数、骨架行数、骨架 sha256。 */
export function fingerprint(absolutePath) {
	const src = readFileSync(absolutePath, 'utf8')
	const bones = skeleton(src)
	return {
		path: absolutePath,
		fileMd5: hash(src, 'md5'),
		fileSha1: hash(src, 'sha1'),
		fileLines: countLines(src),
		skeletonLines: bones.split('\n').length,
		skeletonSha256: hash(bones, 'sha256'),
		bones
	}
}

/**
 * 逐 hunk 断言：`before → after` 的**每一条增删行都必须落在注释里**。
 *
 * 这是骨架比对的独立第二条证据：骨架相等只能说明"代码没变"，而这一条直接说明
 * "改动发生的位置"。两者一起才叫"仅注释"。空改动（0 条）不算证明，调用方自己判断。
 */
export function assertCommentOnly(beforePath, afterPath) {
	let diff = ''
	try {
		diff = execFileSync('diff', ['-U0', beforePath, afterPath], { encoding: 'utf8', stdio: 'pipe' })
	} catch (error) {
		// `diff` 的退出码 1 = "有差异"，那是正常结果，不是错误。
		if (error.status !== 1) throw error
		diff = String(error.stdout ?? '')
	}
	const changed = diff.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
	const offenders = changed.filter((line) => {
		const text = line.slice(1).trim()
		if (text === '') return false
		return !(text.startsWith('//') || text.startsWith('*') || text.startsWith('/*') || text.startsWith('*/'))
	})
	return { changed, offenders }
}

/**
 * 链上三条锚（口径第 10 条，**规则统一为 trim 版**）。
 *
 * ⚠️ **合法变更必须在同一个提交里更新这里的常量**：改代码/测试而忘了更新，`pnpm test`
 * 会当场红（这正是它存在的意义）；反过来，如果这是**有意**的改动，就顺手把新值抄进来，
 * 让它继续咬着"当前树"。纯注释改动**不该**动这三行。
 */
export const ANCHORS = Object.freeze([
	{ path: 'lib/client.js', skeletonSha256: '57729fde78ef223ad61f5cc8b1ba57854737e04da7594a62b224d597710e3689', skeletonLines: 4343 },
	{ path: 'lib/index.js', skeletonSha256: '2b5be057f5079d9ef2fe41ed20611d77c36085edc9fe63551df94a40a654b898', skeletonLines: 804 },
	{ path: 'test/client.test.mjs', skeletonSha256: '47df5e717b72145538f358526fc2089de49c48df186845fb5358cf530c9a646f', skeletonLines: 3974 }
])

/** 复算三条锚。`overrides` 是给测试用的替身路径（`{'lib/client.js': '/tmp/xxx'}`）。 */
export function verifyAnchors(overrides = {}) {
	return ANCHORS.map((anchor) => {
		const actualPath = overrides[anchor.path] ?? join(repoRoot, anchor.path)
		const print = fingerprint(actualPath)
		return {
			path: anchor.path,
			ok: print.skeletonSha256 === anchor.skeletonSha256 && print.skeletonLines === anchor.skeletonLines,
			expected: anchor,
			actual: { skeletonSha256: print.skeletonSha256, skeletonLines: print.skeletonLines }
		}
	})
}

/** 剥离器自测：9 条字面量 + 5 条性质（含**反空断言**）+ 幂等。 */
export function selfTest() {
	const literalCases = [
		['字符串里的 // 不能被当注释', 'var u = "https://example.com/x"; // 真注释\n', 'var u = "https://example.com/x"; \n'],
		['单引号里的 /* 不能被当注释', "var s = '/* not a comment */'; /* 真注释 */\n", "var s = '/* not a comment */'; \n"],
		['转义引号', "var s = 'it\\'s // ok';\n", "var s = 'it\\'s // ok';\n"],
		['模板字面量里的 HTML 与 //', 'var h = `a\n// 不是注释\nb`; // 真注释\n', 'var h = `a\n// 不是注释\nb`; \n'],
		['模板字面量 ${} 里的注释要剥掉', 'var h = `x ${ 1 /* 内层 */ + 2 // 内层行注释\n } y`;\n', 'var h = `x ${ 1  + 2 \n } y`;\n'],
		['正则里的 \\/ 不能被当注释', 'var r = /a\\/\\/b/g; // 真注释\n', 'var r = /a\\/\\/b/g; \n'],
		['字符类里的 / 不算结束', 'var r = /[/]+x/; \n', 'var r = /[/]+x/; \n'],
		['除法不能被当正则起点', 'var v = a / b; //c\n', 'var v = a / b; \n'],
		['块注释整段消失（它内部的换行跟着走）', 'var a = 1;\n/* 一行\n两行 */\nvar b = 2;\n', 'var a = 1;\n\nvar b = 2;\n']
	]
	const failures = []
	for (const [name, input, expected] of literalCases) {
		const actual = stripComments(input)
		if (actual !== expected) failures.push({ name, expected, actual })
	}
	// 幂等：剥过一遍的骨架再剥一遍不该变
	const once = stripComments('var a = 1; // x\n')
	const idempotent = stripComments(once) === once
	/**
	 * 骨架这个量必须**对注释不敏感、对代码敏感** —— 后半句是反空断言：
	 * 一个"永远返回空串"的骨架函数会让"改前改后相同"永远成立（假绿）。
	 */
	const properties = {
		注释变长骨架不变: skeleton('var a = 1;\n// c\nvar b = 2;\n') === skeleton('var a = 1;\n// c\n// c2\n// c3\nvar b = 2;\n'),
		行尾注释长度不影响骨架: skeleton('var a = 1; // x\n') === skeleton('var a = 1; // 长得多的一句注释\n'),
		改代码会改变骨架: skeleton('var a = 1;\n') !== skeleton('var a = 2;\n'),
		删代码行会改变骨架: skeleton('var a = 1;\nvar b = 2;\n') !== skeleton('var a = 1;\n'),
		骨架非空: skeleton('var a = 1;\n').length > 0
	}
	const propertyFailures = Object.entries(properties).filter(([, ok]) => ok !== true).map(([name]) => name)
	return { literalCases: literalCases.length, failures, idempotent, properties, propertyFailures }
}

// ------------------------------------------------------------------------- 测试
//
// 本文件同时是"工具"与"它自己的测试"。带 CLI 参数运行时只走工具那条路（见文件尾），
// 不带参数时（`node --test` 或直接 `node test/skeleton-hash.mjs`）注册并跑下面这些。

async function registerTests() {
	const { default: test } = await import('node:test')
	const assert = (await import('node:assert/strict')).default

	test('骨架工具自测：字面量 9/9 + 性质 5/5（含反空断言）+ 幂等', () => {
		const result = selfTest()
		assert.deepEqual(result.failures, [], '字面量用例必须全过')
		assert.equal(result.literalCases, 9)
		assert.deepEqual(result.propertyFailures, [], '性质必须全过')
		assert.equal(Object.keys(result.properties).length, 5)
		assert.equal(result.idempotent, true, '剥离必须幂等')
		// 反空断言的"断言本身"也要被断言：字面量里必须真的包含那两类坑
		assert.equal(result.properties.改代码会改变骨架, true, '改一行代码必须改变骨架')
	})

	test('链上三条锚：用第 10 条规则复算，必须与常量逐字一致（锚变即红）', () => {
		const results = verifyAnchors()
		for (const row of results) {
			assert.equal(row.actual.skeletonLines, row.expected.skeletonLines, `${row.path} 骨架行数变了`)
			assert.equal(row.actual.skeletonSha256, row.expected.skeletonSha256,
				`${row.path} 的代码骨架变了 —— 若这是有意的代码改动，请在同一提交里更新 ANCHORS`)
		}
		assert.equal(results.length, 3)
	})

	test('锚是承重的（反空断言）：改一行代码 → 骨架必变、锚比对必失败', () => {
		// 拿真实文件做一个"只改一个字符、且改的是代码"的替身，证明上面那条不是恒真。
		// 选 `lib/index.js`：`sendHtml()` 里那行响应头是**代码**（不是注释），改了必须让锚红。
		const dir = mkdtempSync(join(tmpdir(), 'dsh-miniapp-skeleton-'))
		const modified = join(dir, 'index.js')
		copyFileSync(join(repoRoot, 'lib/index.js'), modified)
		const src = readFileSync(modified, 'utf8')
		assert.ok(src.includes("'cache-control': 'no-store',"), '替身必须能找到那行代码（否则这条测试自己就跑偏了）')
		writeFileSync(modified, src.replace("'cache-control': 'no-store',", "'cache-control': 'no-cache',"))

		const rows = verifyAnchors({ 'lib/index.js': modified })
		const target = rows.find((row) => row.path === 'lib/index.js')
		assert.equal(target.ok, false, '改了一行代码，锚比对必须失败 —— 否则这条断言是空的')
		// 而且失败的原因必须是**骨架变了**，不是行数凑巧：两者都比一次。
		assert.notEqual(target.actual.skeletonSha256, target.expected.skeletonSha256)
		assert.equal(target.actual.skeletonLines, target.expected.skeletonLines, '这一处改动没有增减代码行，行数应不变')
	})

	test('逐 hunk 断言：纯注释改动通过、代码改动必被抓（负对照）', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dsh-miniapp-comment-only-'))
		const before = join(dir, 'before.mjs')
		const commentOnly = join(dir, 'comment-only.mjs')
		const codeChanged = join(dir, 'code-changed.mjs')
		writeFileSync(before, 'var a = 1;\nvar b = 2;\n')
		writeFileSync(commentOnly, 'var a = 1;\n// 多加一句注释\n// 再加一句\nvar b = 2;\n')
		writeFileSync(codeChanged, 'var a = 1;\nvar b = 3;\n')

		const good = assertCommentOnly(before, commentOnly)
		assert.ok(good.changed.length > 0, '纯注释改动必须真的被看出"改了东西"（0 条不算证明）')
		assert.deepEqual(good.offenders, [])
		// 骨架相等 —— 这才是"仅注释"的正面结论。
		assert.equal(skeleton(readFileSync(before, 'utf8')), skeleton(readFileSync(commentOnly, 'utf8')))

		const bad = assertCommentOnly(before, codeChanged)
		assert.equal(bad.offenders.length, 2, '改代码必须两条（一删一增）都被抓出来')
		assert.notEqual(skeleton(readFileSync(before, 'utf8')), skeleton(readFileSync(codeChanged, 'utf8')))
	})

	test('命令行入口真的能用：--anchors 复现三条锚、--comment-only 的退出码能区分注释与代码', () => {
		// 为什么要测 CLI 而不只测函数：这条测试补的正是"函数都对、命令行参数接错"那一类
		// 缺陷 —— 曾经 `--compare`/`--comment-only` 的参数位多跳了一个，两个文件的路径全错位，
		// 而函数级测试全绿。工具是要被人**一条命令**调起来的，所以命令行本身也要被钉住。
		const run = (cliArgs) => {
			try {
				const stdout = execFileSync(process.execPath, [join(here, 'skeleton-hash.mjs'), ...cliArgs], { encoding: 'utf8', stdio: 'pipe' })
				return { code: 0, stdout }
			} catch (error) {
				return { code: error.status ?? -1, stdout: String(error.stdout ?? '') }
			}
		}

		const anchors = run(['--anchors'])
		assert.equal(anchors.code, 0, '--anchors 必须成功退出')
		for (const anchor of ANCHORS) {
			assert.ok(anchors.stdout.includes(anchor.skeletonSha256), `--anchors 的输出里要有 ${anchor.path} 的骨架哈希`)
		}

		const dir = mkdtempSync(join(tmpdir(), 'dsh-miniapp-cli-'))
		const before = join(dir, 'before.mjs')
		const commentOnly = join(dir, 'comment-only.mjs')
		const codeChanged = join(dir, 'code-changed.mjs')
		writeFileSync(before, 'var a = 1;\nvar b = 2;\n')
		writeFileSync(commentOnly, 'var a = 1;\n// 注释\nvar b = 2;\n')
		writeFileSync(codeChanged, 'var a = 1;\nvar b = 3;\n')
		assert.equal(run(['--comment-only', before, commentOnly]).code, 0, '纯注释必须通过')
		assert.equal(run(['--comment-only', before, codeChanged]).code, 1, '改代码必须非 0 退出')
		assert.equal(run(['--compare', before, commentOnly]).code, 0, '骨架相等 → 0')
		assert.equal(run(['--compare', before, codeChanged]).code, 1, '骨架不等 → 1')
		// 参数缺失时要说人话、并以 2 退出（而不是抛一个 TypeError 堆栈）
		const missing = run(['--compare', before])
		assert.equal(missing.code, 2)
	})
}

// --------------------------------------------------------------------------- CLI

function runCli(args) {
	const mode = args[0]
	if (mode === '--selftest') {
		const result = selfTest()
		for (const failure of result.failures) {
			console.error('自测失败：', failure.name, '\n  expected:', JSON.stringify(failure.expected), '\n  actual  :', JSON.stringify(failure.actual))
		}
		for (const name of result.propertyFailures) console.error('自测失败（性质）：', name)
		const ok = result.failures.length === 0 && result.propertyFailures.length === 0 && result.idempotent
		console.log(`剥离器自测：字面量 ${result.literalCases - result.failures.length}/${result.literalCases}，性质 ${Object.keys(result.properties).length - result.propertyFailures.length}/${Object.keys(result.properties).length}，幂等=${result.idempotent}`)
		process.exit(ok ? 0 : 1)
	}
	if (mode === '--anchors') {
		const rows = verifyAnchors()
		for (const row of rows) {
			console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.path}  骨架 ${row.actual.skeletonLines} 行  sha256 ${row.actual.skeletonSha256}`)
			if (!row.ok) console.log(`     期望 ${row.expected.skeletonLines} 行 / ${row.expected.skeletonSha256}`)
		}
		process.exit(rows.every((row) => row.ok) ? 0 : 1)
	}
	if (mode === '--report') {
		for (const path of args.slice(1)) {
			const print = fingerprint(resolve(path))
			console.log(JSON.stringify({
				path, fileMd5: print.fileMd5, fileSha1: print.fileSha1,
				fileLines: print.fileLines, skeletonLines: print.skeletonLines, skeletonSha256: print.skeletonSha256
			}))
		}
		process.exit(0)
	}
	if (mode === '--compare') {
		// `args` 已经是从 argv 切好的那一段（`['--compare', before, after]`），
		// 所以这里只跳掉 mode 自己 —— 曾经写成 `[, , a, b]`，多跳了一个，结果 after 是 undefined。
		const [, beforePath, afterPath] = args
		if (beforePath === undefined || afterPath === undefined) usage('--compare 需要两个文件路径')
		const before = fingerprint(resolve(beforePath))
		const after = fingerprint(resolve(afterPath))
		const same = before.bones === after.bones
		console.log(`骨架（第 10 条规则）逐字节相同: ${same}`)
		console.log(`  before 骨架 ${before.skeletonLines} 行 sha256 ${before.skeletonSha256}  文件 md5 ${before.fileMd5} sha1 ${before.fileSha1} 总行 ${before.fileLines}`)
		console.log(`  after  骨架 ${after.skeletonLines} 行 sha256 ${after.skeletonSha256}  文件 md5 ${after.fileMd5} sha1 ${after.fileSha1} 总行 ${after.fileLines}`)
		process.exit(same ? 0 : 1)
	}
	if (mode === '--comment-only') {
		const [, beforePath, afterPath] = args
		if (beforePath === undefined || afterPath === undefined) usage('--comment-only 需要两个文件路径')
		const result = assertCommentOnly(beforePath, afterPath)
		console.log(`改动行 ${result.changed.length} 条，其中非注释行 ${result.offenders.length} 条`)
		for (const line of result.offenders) console.log('   ✖', JSON.stringify(line))
		if (result.changed.length === 0) console.log('警告：两侧没有差异 —— 0 条改动不算"仅注释"的证明')
		process.exit(result.offenders.length === 0 ? 0 : 1)
	}
	usage(`未知参数：${args.join(' ')}`)
}

function usage(message) {
	console.error(message)
	console.error('用法：--anchors | --report <files…> | --compare <before> <after> | --comment-only <before> <after> | --selftest')
	process.exit(2)
}

const CLI_MODES = new Set(['--selftest', '--anchors', '--report', '--compare', '--comment-only'])
if (process.argv.slice(2).some((arg) => CLI_MODES.has(arg))) runCli(process.argv.slice(2))
else await registerTests()
