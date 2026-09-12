// dsh-miniapp — 核心逻辑冒烟测试。
//
// 不依赖 DSH 宿主，直接跑存储层与校验器。这两块是插件的实质，装进 profile 之前
// 先在本地证明它们是对的：规则清单、发布四道闸、两层存储的派生标记、路径公式。
//
// 运行：node --test test/

import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { MiniAppBadRequest, MiniAppNotFound, MiniAppStore, isMiniAppId, mtimeMsOf, newMiniAppId } from '../lib/store.js'
import {
	IMPORT_RULE_IDS,
	applyFixes,
	clampName,
	groupFindings,
	looksLikeHtmlDocument,
	readDocumentTitle,
	suggestName,
	validateImport
} from '../lib/validate.js'

/** 一个最小但完整的自包含页面。 */
const GOOD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>番茄钟</title></head>
<body><main><h1>番茄钟</h1><button onclick="alert(1)">开始</button></main></body></html>
`

async function withStore(run) {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-miniapp-test-'))
	try {
		return await run(new MiniAppStore(dir), dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

/** 把文件的 mtime 推到 `ms`，用来稳定地模拟「发布之后又改过」。 */
async function setMtime(path, ms) {
	const seconds = ms / 1000
	await utimes(path, seconds, seconds)
}

// ------------------------------------------------------------------ id 与路径

test('id 是小写裸 UUIDv7，且路径是 id 的纯函数', async () => {
	const id = newMiniAppId()
	assert.ok(isMiniAppId(id), `不是合法 UUIDv7: ${id}`)
	assert.equal(id, id.toLowerCase())
	assert.ok(!isMiniAppId(id.toUpperCase()), '大写必须被拒绝')
	assert.ok(!isMiniAppId('0190f5fe-7c00-4000-8000-000000000001'), 'v4 必须被拒绝')

	await withStore(async (store) => {
		assert.equal(store.appDir(id), join(store.appsDir, id))
		assert.equal(store.workingCopyPath(id), join(store.appsDir, id, 'working.html'))
		// 快照不住在编辑现场里 —— 清掉工作副本目录不能带走线上版本。
		assert.equal(store.snapshotPath(id), join(store.snapshotsDir, `${id}.html`))
		// 同一个 id 永远给出同一个答案：没有路径列可以变陈旧。
		assert.equal(store.appDir(id), store.appDir(id))
		assert.throws(() => store.appDir('../../etc'), MiniAppBadRequest)
		assert.throws(() => store.snapshotPath('../../etc'), MiniAppBadRequest)
	})
})

// ------------------------------------------------------------------ 校验规则

test('规则清单是闭集：发出的每个 id 都在清单里', () => {
	const samples = [
		'',
		'<script>console.log(1)</script>',
		'<div>片段</div>',
		GOOD_HTML,
		'<html><body><img src="./a.png"></body></html>',
		'<html><body><script src="http://localhost:8000/x.js"></script></body></html>',
		'<html><body><script type="module">import x from "lodash"</script></body></html>',
		'<html><body><p><?php echo 1 ?></p></body></html>',
		'<html><body><script src="https://cdn.example.com/a.js"></script><iframe src="x"></iframe><script>localStorage.setItem("a","b")</script></body></html>',
		'<html><body><script src="/src/main.ts"></script></body></html>',
		// 一条超大文档，用来触发 size_over_limit。
		`<html><body>${'x'.repeat(4 * 1024 * 1024)}</body></html>`
	]
	const emitted = new Set()
	for (const sample of samples) {
		for (const finding of validateImport(sample).findings) emitted.add(finding.rule_id)
	}
	for (const ruleId of emitted) {
		assert.ok(IMPORT_RULE_IDS.includes(ruleId), `发出了清单外的规则：${ruleId}`)
	}
	// 反向：清单里的每一条都必须至少能在一个样本上触发，否则清单在撒谎。
	for (const ruleId of IMPORT_RULE_IDS) {
		assert.ok(emitted.has(ruleId), `规则 ${ruleId} 从未被触发，清单与实现已经漂移`)
	}
})

test('超大文档报实际字节数，且是 fatal', () => {
	const oversized = `<html><body>${'x'.repeat(4 * 1024 * 1024)}</body></html>`
	const report = validateImport(oversized)
	const finding = report.findings.find((f) => f.rule_id === 'size_over_limit')
	assert.ok(finding, '必须报 size_over_limit')
	assert.equal(finding.severity, 'fatal')
	assert.equal(finding.detail, String(Buffer.byteLength(oversized, 'utf8')))
	assert.equal(report.blocked, true)
})

test('恰好 4 MiB 通过，多一个字节就被拒', () => {
	const cap = 4 * 1024 * 1024
	const shell = '<html><body></body></html>'
	const exact = `<html><body>${'x'.repeat(cap - Buffer.byteLength(shell, 'utf8'))}</body></html>`
	assert.equal(Buffer.byteLength(exact, 'utf8'), cap)
	assert.ok(!validateImport(exact).findings.some((f) => f.rule_id === 'size_over_limit'))
	assert.ok(validateImport(`${exact} `).findings.some((f) => f.rule_id === 'size_over_limit'))
})

test('空载荷立即短路，其余规则不再扫描', () => {
	const report = validateImport('   ')
	assert.deepEqual(report.findings.map((f) => f.rule_id), ['empty_payload'])
	assert.equal(report.blocked, true)
})

test('粘贴的脚本不是 HTML，且停止扫描', () => {
	const report = validateImport('<script src="./a.js"></script>')
	assert.deepEqual(report.findings.map((f) => f.rule_id), ['not_html'])
	assert.equal(report.blocked, true)
})

test('片段被包装成完整文档，而不是被拒', () => {
	const report = validateImport('<div>只有片段</div>')
	assert.deepEqual(report.findings.map((f) => f.rule_id), ['fragment_not_document'])
	assert.equal(report.blocked, false, 'autofix 不能阻塞导入')

	const fixed = applyFixes('<div>只有片段</div>', report)
	assert.deepEqual(fixed.applied, ['fragment_not_document'])
	// 包装之后自身必须零 finding —— 否则「自动修复」是一句谎话。
	assert.deepEqual(validateImport(fixed.html).findings, [])
})

test('相对引用是 fatal，即使文件跟它一起导入', () => {
	const report = validateImport('<html><body><link rel="stylesheet" href="./style.css"></body></html>')
	const finding = report.findings.find((f) => f.rule_id === 'local_ref_unsupported')
	assert.ok(finding, '必须报 local_ref_unsupported')
	assert.equal(finding.severity, 'fatal')
	assert.equal(finding.detail, './style.css')
	assert.equal(report.blocked, true)
})

test('本机开发服务器地址是 fatal，且不会被重复计为 CDN', () => {
	const report = validateImport('<html><body><img src="http://localhost:3000/a.png"></body></html>')
	const ids = report.findings.map((f) => f.rule_id)
	assert.ok(ids.includes('dev_server_ref'))
	assert.ok(!ids.includes('external_cdn_ref'), 'localhost 只算 dev ref，不算 CDN')
})

test('藏在 fetch 里的本机地址同样被抓住', () => {
	const report = validateImport('<html><body><script>fetch("http://127.0.0.1:8000/api")</script></body></html>')
	assert.ok(report.findings.some((f) => f.rule_id === 'dev_server_ref'))
})

test('服务端模板语法是 fatal，但客户端插值不误报', () => {
	assert.ok(validateImport('<html><body><p><?php echo 1; ?></p></body></html>').findings.some((f) => f.rule_id === 'server_template_markers'))
	// Vue / Alpine / Handlebars 都用 {{ }}，在客户端合法；JS 模板串同理。
	assert.ok(!validateImport('<html><body><p>{{ count }}</p></body></html>').findings.some((f) => f.rule_id === 'server_template_markers'))
	assert.ok(!validateImport('<html><body><script>const s = `${a}`</script></body></html>').findings.some((f) => f.rule_id === 'server_template_markers'))
})

test('裸包名导入是 fatal，除非有 importmap 覆盖', () => {
	const bare = '<html><body><script type="module">import x from "lodash"</script></body></html>'
	assert.ok(validateImport(bare).findings.some((f) => f.rule_id === 'esm_bare_specifier'))

	const mapped = '<html><body><script type="importmap">{"imports":{"lodash":"https://cdn.example.com/lodash.js"}}</script><script type="module">import x from "lodash"</script></body></html>'
	assert.ok(!validateImport(mapped).findings.some((f) => f.rule_id === 'esm_bare_specifier'))

	const url = '<html><body><script type="module">import x from "https://cdn.example.com/a.js"</script></body></html>'
	assert.ok(!validateImport(url).findings.some((f) => f.rule_id === 'esm_bare_specifier'))
})

test('CDN / 存储 / 嵌套 iframe 只警告，不阻塞', () => {
	const report = validateImport('<html><body><script src="https://cdn.example.com/a.js"></script><script>localStorage.x=1</script><iframe src="https://x.example"></iframe></body></html>')
	const ids = report.findings.map((f) => f.rule_id)
	for (const expected of ['external_cdn_ref', 'web_storage_use', 'nested_iframe_embed']) {
		assert.ok(ids.includes(expected), `缺少 ${expected}`)
		assert.equal(report.findings.find((f) => f.rule_id === expected).severity, 'warning')
	}
	assert.equal(report.blocked, false)
})

test('blocked 精确等于「存在 fatal」', () => {
	assert.equal(validateImport(GOOD_HTML).blocked, false)
	assert.equal(validateImport('<html><body><img src="./a.png"></body></html>').blocked, true)
})

test('分组按严重度排序，未知档位另起一组而不是丢掉', () => {
	const groups = groupFindings([
		{ rule_id: 'web_storage_use', severity: 'warning' },
		{ rule_id: 'local_ref_unsupported', severity: 'fatal' },
		{ rule_id: 'fragment_not_document', severity: 'autofix' },
		{ rule_id: 'future_rule', severity: 'brand-new-tier' }
	])
	assert.deepEqual(groups.map((g) => g.severity), ['fatal', 'autofix', 'warning', 'other'])
	assert.equal(groups[3].findings[0].rule_id, 'future_rule')
})

test('命名：优先 title，其次文件名，过长按码点截断', () => {
	assert.equal(suggestName('<html><head><title>  番茄钟  </title></head></html>', 'x.html'), '番茄钟')
	assert.equal(suggestName('<html><body></body></html>', '/tmp/我的工具.html'), '我的工具')
	assert.equal(suggestName('<html><body></body></html>', 'x.html'), 'x')

	// ---- 取 <title> 必须是有界扫描 ----
	//
	// 这条测试是从一个**真机抓到的 DoS** 来的：原来的实现是
	// `/<title[^>]*>([\s\S]*?)<\/title>/i`，在"有 `<title` 但没有闭合"的输入上是**二次**的
	// —— `[^>]*` 从每个位置一路扫到串尾。实测 120 KB 的 `'<title'.repeat(20000)` 要 3.5 秒，
	// 4 MiB 是小时级；而它是**同步**路径（导入工具与 POST /import），期间整个 host 的事件
	// 循环、所有会话的流式输出都被钉死。
	assert.equal(readDocumentTitle('<html><head><title>  番茄钟 </title></head></html>'), '番茄钟')
	// 大写的、带属性的都要认（老实现靠 `/i` 与 `[^>]*`，新实现靠 `/<title[\s>]/i`）。
	assert.equal(readDocumentTitle('<html><head><TITLE lang="zh">记账本</TITLE>'), '记账本')
	assert.equal(readDocumentTitle('<html><body>没有标题</body></html>'), undefined)
	assert.equal(readDocumentTitle(''), undefined)

	// 病态输入：不闭合、只有开标签、成吨重复。
	const pathological = [
		'<title'.repeat(20000),
		'<title>'.repeat(20000),
		'<title'.repeat(50000),
		'<title lang="'.repeat(10000)
	]
	const startedAt = Date.now()
	for (const html of pathological) {
		// 老实现在这里要几秒到几十秒；新实现是线性的，只扫开头 256 KiB。
		assert.equal(readDocumentTitle(html), undefined)
	}
	const elapsed = Date.now() - startedAt
	// 阈值给得极宽（新实现实测 0-1 ms / 每个输入）：它要抓的是**复杂度**，不是常数因子。
	assert.ok(elapsed < 2000, `病态输入不该把事件循环钉死，实测 ${elapsed} ms`)

	// 超长文档也要有界：4 MiB 全是不闭合标签，仍必须立刻返回。
	const huge = '<title'.repeat(600000) // ≈ 3.6 MiB
	const hugeStartedAt = Date.now()
	assert.equal(readDocumentTitle(huge), undefined)
	assert.ok(Date.now() - hugeStartedAt < 2000, '4 MiB 级输入也必须立刻返回')

	// 标题在很后面（超过扫描窗口）时退回文件名推断，而不是把整个文档扫一遍。
	const late = '<div>'.repeat(60000) + '<title>太靠后了</title>'
	assert.equal(suggestName(late, 'fallback.html'), 'fallback')

	const long = '番'.repeat(150)
	assert.equal(Array.from(clampName(long)).length, 100)
	// 按码点而不是 UTF-16 单元：切半个 emoji 会留下孤立代理项，JSON 编码直接失败。
	const emoji = '🍅'.repeat(150)
	const clampedEmoji = clampName(emoji)
	assert.equal(Array.from(clampedEmoji).length, 100)
	assert.equal(clampedEmoji, '🍅'.repeat(100), '不能切在代理对中间')
	assert.ok(!clampedEmoji.includes('\uFFFD'))
})

test('looksLikeHtmlDocument 认得文档，不认脚本与数据', () => {
	assert.equal(looksLikeHtmlDocument(GOOD_HTML), true)
	assert.equal(looksLikeHtmlDocument('<div>x</div>'), true)
	assert.equal(looksLikeHtmlDocument('{"a":1}'), false)
	assert.equal(looksLikeHtmlDocument('Error: something failed\n  at foo'), false)
})

// ------------------------------------------------------------------ 两层存储

test('新建：写入工作副本，未发布时没有快照', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟' })
		assert.ok(isMiniAppId(app.miniapp_id))
		assert.equal(app.published_at, null)
		assert.equal(app.html_size, 0)
		assert.equal(app.has_unpublished_changes, false, '没有内容就谈不上未发布改动')
		assert.equal(await store.readSnapshot(app.miniapp_id), undefined, '尚未发布时不能有快照')

		const source = await readFile(app.source_path, 'utf8')
		assert.equal(source, '', '工作副本已物化，是一个空骨架')
	})
})

test('带 html 新建即一次发布：快照与工作副本是同一份文档', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟', html: GOOD_HTML })
		assert.equal(app.html_size, Buffer.byteLength(GOOD_HTML, 'utf8'))
		assert.equal(await store.readSnapshot(app.miniapp_id), GOOD_HTML)
		assert.equal(await store.readWorkingCopy(app.miniapp_id), GOOD_HTML)
		assert.equal(app.has_unpublished_changes, false, '刚发布完不该报未发布')
	})
})

test('列表按最近更新降序，且响应永不携带 HTML 正文', async () => {
	await withStore(async (store) => {
		const first = await store.create({ name: '甲', html: GOOD_HTML })
		const second = await store.create({ name: '乙', html: GOOD_HTML })
		await store.update(first.miniapp_id, { name: '甲改' })
		const list = await store.list()
		assert.equal(list[0].miniapp_id, first.miniapp_id)
		assert.equal(list[1].miniapp_id, second.miniapp_id)
		assert.ok(!('html' in list[0]), '列表响应不得包含 html 正文')
	})
})

test('发布四道闸：无工作副本 / 非 UTF-8 / 不是文档 / 正常提升', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟', html: GOOD_HTML })
		const source = store.workingCopyPath(app.miniapp_id)

		// 闸 1：把工作副本删掉 —— 「还没迭代过」是用户可以自己修的状态，不是 404。
		await rm(source, { force: true })
		await assert.rejects(() => store.publish(app.miniapp_id), (error) => {
			assert.ok(error instanceof MiniAppBadRequest)
			assert.match(error.message, /工作副本/)
			return true
		})

		// 闸 2：非 UTF-8 字节。
		await writeFile(source, Buffer.from([0xff, 0xfe, 0x00, 0x01]))
		await assert.rejects(() => store.publish(app.miniapp_id), MiniAppBadRequest)

		// 闸 3：写了东西但不是网页（比如一轮出错留下的计划稿）。
		await writeFile(source, 'TODO: 先想清楚时区再动手', 'utf8')
		await assert.rejects(() => store.publish(app.miniapp_id), (error) => {
			assert.match(error.message, /HTML/)
			return true
		})
		// 被拒之后，线上版本必须原样不动 —— 没有上一版可回退，所以不能变坏。
		assert.equal(await store.readSnapshot(app.miniapp_id), GOOD_HTML)

		// 闸 4：正常提升。
		const v2 = GOOD_HTML.replace('番茄钟</h1>', '番茄钟 v2</h1>')
		await writeFile(source, v2, 'utf8')
		const published = await store.publish(app.miniapp_id)
		assert.equal(await store.readSnapshot(app.miniapp_id), v2)
		assert.equal(published.has_unpublished_changes, false)
		assert.equal(published.html_size, Buffer.byteLength(v2, 'utf8'))
	})
})

test('未发布标记由 mtime 派生：改过就亮，发布后灭', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟', html: GOOD_HTML })
		const source = store.workingCopyPath(app.miniapp_id)
		assert.equal((await store.getProjected(app.miniapp_id)).has_unpublished_changes, false)

		// 模拟 agent 之后又改了工作副本：把 mtime 推到明显晚于发布时间。
		await writeFile(source, GOOD_HTML + '<!-- 改过 -->', 'utf8')
		await setMtime(source, Date.now() + 5000)
		assert.equal((await store.getProjected(app.miniapp_id)).has_unpublished_changes, true)

		await store.publish(app.miniapp_id)
		assert.equal((await store.getProjected(app.miniapp_id)).has_unpublished_changes, false)
	})
})

test('有工作副本但从没盖过章，一律算未发布（安全的失败方向）', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '草稿' })
		await writeFile(store.workingCopyPath(app.miniapp_id), GOOD_HTML, 'utf8')
		const projected = await store.getProjected(app.miniapp_id)
		assert.equal(projected.published_at, null)
		assert.equal(projected.has_unpublished_changes, true)
	})
})

test('物化是幂等的，且不会覆盖在途编辑', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟', html: GOOD_HTML })
		const source = store.workingCopyPath(app.miniapp_id)
		const edited = GOOD_HTML + '<!-- 正在迭代 -->'
		await writeFile(source, edited, 'utf8')

		const again = await store.ensureWorkingCopy(app.miniapp_id)
		assert.equal(again, source)
		assert.equal(await readFile(source, 'utf8'), edited, '在途编辑被覆盖了')

		// 目录被删掉（换了 work_dir / 手工清理）后仍能自愈。
		await rm(store.appDir(app.miniapp_id), { recursive: true, force: true })
		const healed = await store.ensureWorkingCopy(app.miniapp_id)
		assert.equal(healed, source)
		assert.equal(await readFile(source, 'utf8'), GOOD_HTML, '应当从快照重新物化')
	})
})

test('更新元数据不算发布，带 html 的更新算发布', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟', html: GOOD_HTML })
		await store.update(app.miniapp_id, { name: '新名字', icon: '🍅' })
		assert.equal(await store.readSnapshot(app.miniapp_id), GOOD_HTML, '改名不该动快照')

		const v2 = GOOD_HTML.replace('番茄钟', '计时器')
		await store.update(app.miniapp_id, { html: v2 })
		assert.equal(await store.readSnapshot(app.miniapp_id), v2)
		assert.equal(await store.readWorkingCopy(app.miniapp_id), v2, '带 html 的更新要同步工作副本')
		assert.equal((await store.getProjected(app.miniapp_id)).has_unpublished_changes, false)
	})
})

test('空更新被拒绝，而不是悄悄返回一行没变的记录', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟' })
		await assert.rejects(() => store.update(app.miniapp_id, {}), MiniAppBadRequest)
	})
})

test('带 html 的 update 与 create 也必须过"这是不是 HTML 文档"那道闸', async () => {
	// publish 有四道闸，其中"不是文档"那道是防止一段笔记/栈回溯顶掉正在用的工具。
	// 但**带 html 的 update/create 同样会把正文写进 snapshot**，也就是同样是"发布" ——
	// 代理实测过：`POST /api/apps/{id}` 带一段栈回溯曾返回 200 并原样直出。
	await withStore(async (store) => {
		const good = '<!doctype html><html><body><b>ok</b></body></html>'
		const app = await store.create({ name: '闸门', html: good })

		// update 带一份不是文档的正文：必须拒绝，且**快照一个字节都不能动**。
		await assert.rejects(
			() => store.update(app.miniapp_id, { html: 'this is a stack trace, not a document' }),
			/MiniAppBadRequest|不是 HTML 文档/
		)
		assert.equal(await store.readSnapshot(app.miniapp_id), good, '被拒绝的 update 不该改动已发布快照')

		// create 带同样的正文：同样拒绝（它也是"建好即发布"）。
		await assert.rejects(
			() => store.create({ name: '闸门2', html: 'not a document either' }),
			/MiniAppBadRequest|不是 HTML 文档/
		)
	})
})

test('从未发布过的小程序，ensureWorkingCopy 不许给它盖上 published_at', async () => {
	// `published_at` 的契约是"从未发布时为 null"，而 API 会把它交给客户端。
	// 盖了戳却没有快照，wire 上就是"说发布了、/serve 却 404"。
	await withStore(async (store, dir) => {
		const app = await store.create({ name: '没发布过' })
		assert.equal(app.published_at, null, '刚建、没带 html：published_at 必须是 null')
		await rm(join(dir, 'apps', app.miniapp_id), { recursive: true, force: true })
		const path = await store.ensureWorkingCopy(app.miniapp_id)
		assert.ok(path.endsWith('working.html'))
		const after = await store.get(app.miniapp_id)
		assert.equal(after.published_at, null, '没有快照就不该有发布时间')
		assert.equal(await store.readSnapshot(app.miniapp_id), undefined)
	})
})

test('mtime 取值类型无关：BigInt / Number / 字段缺失 / null 都不许抛', () => {
	// 这个坑不是假想的：`stat(path,{bigint:true})` 在真实 fs 上给 BigInt，但 Electron 的
	// asar shim 对归档内路径返回**手工拼的** stats —— 字段可能是 Number 甚至缺失。
	// 上游 dsh-fs-local 正是在 `Number(mode & 511n)`（位运算碰 BigInt）上抛 TypeError，
	// 一抛把整条技能来源都带没了。我们自己的取值必须**只在关系比较与 Number() 上**，
	// 任何一种形状进来都不抛。
	assert.equal(mtimeMsOf(null), 0)
	assert.equal(mtimeMsOf(undefined), 0)
	assert.equal(mtimeMsOf({}), 0, '什么字段都没有：0，不抛')
	// 真实 fs 的形状（BigInt）。除以 1e6 有浮点精度损失，所以用容差而不是逐位相等 ——
	// 这条测试要钉的是"不抛 + 量级对"，不是二进制表示。
	const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ≉ ${expected}`)
	near(mtimeMsOf({ mtimeNs: 1789063933532123456n, size: 100n }), 1789063933532.1235)
	// asar shim 的形状（Number）—— 同样的表达式不许抛
	near(mtimeMsOf({ mtimeNs: 1789063933532123456, size: 100 }), 1789063933532.1235)
	// shim 连 mtimeNs 都没有：落到 mtimeMs（它本来就是毫秒，别再除 1e6）
	assert.equal(mtimeMsOf({ mtimeMs: 1789063933532 }), 1789063933532)
	assert.equal(mtimeMsOf({ mtimeMs: 1789063933532.5 }), 1789063933532.5)
	// 零与负值：当作"没有"（时钟早于 epoch 的既定口径）
	assert.equal(mtimeMsOf({ mtimeNs: 0n }), 0)
	assert.equal(mtimeMsOf({ mtimeMs: -5 }), 0)
})

test('绊线：lib/ 里不许出现"位运算碰 BigInt 字面量"的写法', async () => {
	// `Number(x & 511n)` 这一类（Number 与 BigInt 做位运算）会**直接抛**
	// `Cannot mix BigInt and other types` —— 上游 dsh-fs-local 的技能来源就是这么没的。
	// 关系比较（>、<）与 Number() 都允许混用，位运算（&、|、^、<<）不允许。
	// 这条测试就是给那个坑装的绊线：谁写进来立刻红。
	const files = ['lib/index.js', 'lib/store.js', 'lib/validate.js', 'lib/templates.js', 'lib/client.js']
	for (const file of files) {
		// 用 import.meta.url 定位（node --test 的 cwd 不一定是 test/）。
		const source = await readFile(new URL('../' + file, import.meta.url), 'utf8')
		// 剥掉注释再查：注释里**正当地讨论**这个坑（比如 mtimeMsOf 的文档就引用了
		// 上游那句 `Number(mode & 511n)`）—— 不剥离的话，讨论本身就是一次误报。
		// 与 client.test.mjs 的 stripComments 同一先例。
		const bare = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
		const hits = bare.match(/&\s*\d+n\b/g) ?? []
		assert.equal(hits.length, 0, `${file} 里出现了位运算碰 BigInt 字面量（${hits[0]}）—— 那会抛 Cannot mix BigInt`)
	}
})

test('删除带走两个树：工作副本目录与快照文件', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟', html: GOOD_HTML })
		const dir = store.appDir(app.miniapp_id)
		const snapshot = store.snapshotPath(app.miniapp_id)
		assert.equal(await readFile(snapshot, 'utf8'), GOOD_HTML)

		await store.remove(app.miniapp_id)
		assert.equal(await store.list().then((l) => l.length), 0)
		await assert.rejects(() => store.get(app.miniapp_id), MiniAppNotFound)
		await assert.rejects(() => readFile(join(dir, 'working.html'), 'utf8'))
		await assert.rejects(() => readFile(snapshot, 'utf8'), '快照也必须被带走')
	})
})

test('线上版本活过它的编辑现场：清掉工作副本目录不影响已发布快照', async () => {
	await withStore(async (store) => {
		const app = await store.create({ name: '番茄钟', html: GOOD_HTML })
		// 模拟「换工作区 / 手工清理 / 一次失败的批量删除」把编辑现场整棵删掉。
		await rm(store.appDir(app.miniapp_id), { recursive: true, force: true })

		// 正在用的工具必须照常可用 —— 这是两层存储的全部意义。
		assert.equal(await store.readSnapshot(app.miniapp_id), GOOD_HTML)

		// 反向也要成立：现场可以自愈，物化回快照那一版。
		const source = await store.ensureWorkingCopy(app.miniapp_id)
		assert.equal(await readFile(source, 'utf8'), GOOD_HTML)
	})
})

test('元数据校验：name 必填、按码点计数、空 icon 清成 null', async () => {
	await withStore(async (store) => {
		await assert.rejects(() => store.create({ name: '   ' }), MiniAppBadRequest)
		await assert.rejects(() => store.create({ name: '番'.repeat(101) }), MiniAppBadRequest)
		const ok = await store.create({ name: '番'.repeat(100), icon: '🍅' })
		assert.equal(ok.icon, '🍅')
		const cleared = await store.update(ok.miniapp_id, { icon: '  ' })
		assert.equal(cleared.icon, null, '空白 icon 应清成 null，让卡片回退默认字形')
	})
})

test('索引文件损坏时拒绝启动，而不是假扮成空库', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-miniapp-corrupt-'))
	try {
		await writeFile(join(dir, 'index.json'), '{ 这不是 JSON', 'utf8')
		const store = new MiniAppStore(dir)
		await assert.rejects(() => store.load(), /index\.json/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('重新加载后库仍在（索引落盘有效）', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-miniapp-reload-'))
	try {
		const first = new MiniAppStore(dir)
		const app = await first.create({ name: '番茄钟', html: GOOD_HTML })
		const second = new MiniAppStore(dir)
		const list = await second.list()
		assert.equal(list.length, 1)
		assert.equal(list[0].miniapp_id, app.miniapp_id)
		assert.equal(list[0].name, '番茄钟')
		assert.equal(await second.readSnapshot(app.miniapp_id), GOOD_HTML)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
