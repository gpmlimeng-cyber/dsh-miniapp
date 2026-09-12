// dsh-miniapp — storage layer.
//
// Two-layered on purpose, exactly like the NomiFun Desktop original it is
// ported from:
//
//   * the PUBLISHED SNAPSHOT lives in `apps/{id}/published.html` and is the
//     only thing the runner iframe is ever served. It can never be half a
//     document, because nothing writes it in place — `publish` reads a
//     finished working copy and swaps the bytes in one rename.
//   * the WORKING COPY lives in `apps/{id}/working.html` and is what an agent
//     edits. Breaking it cannot break the tool the user is relying on, and
//     "the AI changed it" and "the app changed" stay two separate events.
//
// The path of every app is a pure function of its id, so there is no path
// column to go stale and the library survives the data directory moving.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Current on-disk index shape. Bumped only by a structural change. */
export const STORE_FORMAT_VERSION = 1

/**
 * 从一个 stats 形状的对象里取"带亚毫秒精度的 mtime 毫秒数"。**类型无关。**
 *
 * 为什么必须类型无关：`stat(path, { bigint: true })` 在真实文件系统上给 BigInt 字段，
 * 但 Electron 的 asar shim 对**归档内**路径返回的是手工拼的 stats 对象，字段可能是
 * Number、甚至缺失（上游 `dsh-fs-local` 正是在 `Number(mode & 511n)` 上抛
 * `Cannot mix BigInt and other types`，一抛把整条技能来源都带没了 —— 那个坑的实录
 * 见 docs/research/skill-provider-asar-failure.zh-CN.md）。
 *
 * 所以这里**只用关系比较与 Number()**：两者按规范都允许 BigInt/Number 混用；
 * **绝不用位运算**（`& BigInt` 才是会抛的那个）。字段缺失时落到 mtimeMs，再缺失给 0。
 */
export function mtimeMsOf(info) {
	if (info === null || info === undefined) return 0
	const ns = info.mtimeNs
	if (ns !== undefined && ns !== null && ns > 0) return Number(ns) / 1e6
	const ms = info.mtimeMs
	if (ms !== undefined && ms !== null && ms > 0) return Number(ms)
	return 0
}


/** The one file name a mini-app source is allowed to be. */
export const WORKING_COPY_FILE = 'working.html'

/** Maximum size of one mini-app document, in bytes (4 MiB, as upstream). */
export const HTML_MAX_BYTES = 4 * 1024 * 1024
/** Maximum lengths of the human-facing fields. */
export const NAME_MAX_CHARS = 100
export const DESCRIPTION_MAX_CHARS = 500
export const ICON_MAX_CHARS = 16

/**
 * Mint a bare lowercase UUIDv7.
 *
 * Time-ordered so the index sorts sensibly, and carrying 74 random bits so the
 * id doubles as the unguessable capability in the serve URL. Deliberately the
 * same id shape as the original: the serve route is reachable without a
 * credential (an iframe subresource carries none), so the id IS the guard.
 */
export function newMiniAppId() {
	const bytes = randomBytes(16)
	const ms = Date.now()
	// 48-bit big-endian millisecond timestamp in the first six bytes.
	bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
	bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
	bytes[2] = Math.floor(ms / 2 ** 24) & 0xff
	bytes[3] = Math.floor(ms / 2 ** 16) & 0xff
	bytes[4] = Math.floor(ms / 2 ** 8) & 0xff
	bytes[5] = ms & 0xff
	// version 7 in the high nibble of byte 6, RFC 4122 variant in byte 8.
	bytes[6] = (bytes[6] & 0x0f) | 0x70
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	const hex = bytes.toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** True for a bare lowercase UUIDv7 — the only id shape this store mints. */
export function isMiniAppId(value) {
	return typeof value === 'string'
		&& /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

/** Character count, counted the way a human counts (code points, not UTF-16 units). */
function charCount(value) {
	return Array.from(value).length
}

/** A trimmed string, or undefined when the input is not a usable string. */
function trimmed(value) {
	return typeof value === 'string' ? value.trim() : undefined
}

/**
 * A validation failure that maps to a 400 rather than a 500. The message is
 * safe to show a user or a model: it names the field and the rule.
 */
export class MiniAppBadRequest extends Error {
	constructor(message) {
		super(message)
		this.name = 'MiniAppBadRequest'
	}
}

/** A validation failure that maps to a 404. */
export class MiniAppNotFound extends Error {
	constructor(message) {
		super(message)
		this.name = 'MiniAppNotFound'
	}
}

/** In-memory index entry. Every field is JSON-safe; the HTML never lives here. */
function normaliseEntry(raw) {
	const entry = {
		miniapp_id: String(raw.miniapp_id),
		name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : '未命名小程序',
		description: typeof raw.description === 'string' ? raw.description : '',
		icon: typeof raw.icon === 'string' && raw.icon.length > 0 ? raw.icon : null,
		html_size: Number.isFinite(raw.html_size) ? raw.html_size : 0,
		published_at: Number.isFinite(raw.published_at) ? raw.published_at : null,
		created_at: Number.isFinite(raw.created_at) ? raw.created_at : Date.now(),
		updated_at: Number.isFinite(raw.updated_at) ? raw.updated_at : Date.now(),
		// Provenance only. Never used for navigation: an app outlives every
		// session that ever edited it.
		source_session_id: typeof raw.source_session_id === 'string' ? raw.source_session_id : null
	}
	return entry
}

/**
 * A file-backed mini-app library.
 *
 * The whole index is held in memory and rewritten atomically on every
 * mutation. That is the right trade for a library a human curates by hand:
 * reads are free, writes are rare, and the file stays diffable.
 */
export class MiniAppStore {
	/**
	 * @param root - data directory, e.g. `{DSH_HOME}/miniapp`.
	 */
	constructor(root) {
		this.root = root
		this.indexPath = join(root, 'index.json')
		this.appsDir = join(root, 'apps')
		// 快照与工作副本刻意分处两棵树。这不是洁癖：工作副本是 agent 每一轮都在
		// 改写的地方，也是唯一可能被整目录清掉的地方（换工作区、手工清理、一次
		// 失败的批量删除）。线上版本必须活过它的编辑现场 —— 这正是「迭代中的破坏
		// 不会波及正在用的工具」的实现基础，也是原版把快照放进数据库的理由。
		this.snapshotsDir = join(root, 'snapshots')
		this.prefsPath = join(root, 'prefs.json')
		/** @type {Map<string, object>} */
		this.entries = new Map()
		this.loaded = false
		/** Serialises mutations so two concurrent requests cannot interleave renames. */
		this.pending = Promise.resolve()
	}

	/** Absolute directory of one app's editable side. A pure function of the id. */
	appDir(miniappId) {
		if (!isMiniAppId(miniappId)) throw new MiniAppBadRequest('miniapp_id 不是合法的裸小写 UUIDv7')
		return join(this.appsDir, miniappId)
	}

	/** Absolute path of the working copy an editing session rewrites. */
	workingCopyPath(miniappId) {
		return join(this.appDir(miniappId), WORKING_COPY_FILE)
	}

	/** Absolute path of the published snapshot. Together they are the whole mini-app. */
	snapshotPath(miniappId) {
		if (!isMiniAppId(miniappId)) throw new MiniAppBadRequest('miniapp_id 不是合法的裸小写 UUIDv7')
		return join(this.snapshotsDir, `${miniappId}.html`)
	}

	/** Read `index.json` once. A missing file is an empty library, not an error. */
	async load() {
		if (this.loaded) return this
		await mkdir(this.appsDir, { recursive: true })
		try {
			const text = await readFile(this.indexPath, 'utf8')
			const parsed = JSON.parse(text)
			const rows = Array.isArray(parsed) ? parsed : parsed?.apps
			if (Array.isArray(rows)) {
				// id 不合法的行**不能静默丢掉**：index.json 是唯一权威，下一次 flush 会整份重写，
				// 被丢掉的那一行就永久消失了（apps/{id}/ 还留在盘上成为永远列不出来的孤儿）。
				// 与"坏 JSON"走同一条路：拒绝启动，并说清是哪一行。
				const rejected = []
				for (const [index, row] of rows.entries()) {
					if (row && isMiniAppId(row.miniapp_id)) this.entries.set(row.miniapp_id, normaliseEntry(row))
					else rejected.push(`apps[${index}] (miniapp_id=${JSON.stringify(row?.miniapp_id ?? null)})`)
				}
				if (rejected.length > 0) {
					throw new Error(
						`miniapp: index.json has ${rejected.length} row(s) with an unusable miniapp_id: ` +
						`${rejected.slice(0, 5).join(', ')}${rejected.length > 5 ? ', …' : ''}; ` +
						'refusing to start, because the next write would drop them for good'
					)
				}
			}
		} catch (error) {
			if (error?.code !== 'ENOENT') {
				// A corrupt index must not be silently replaced by an empty library —
				// that would look exactly like "all my mini-apps vanished".
				throw new Error(`miniapp: index.json is unreadable (${error?.message ?? error}); refusing to start with an empty library`)
			}
		}
		this.loaded = true
		return this
	}

	/** Run `operation` with mutations serialised behind any in-flight one. */
	async #serial(operation) {
		const run = this.pending.then(operation, operation)
		// Keep the chain alive even when this link rejects.
		this.pending = run.then(() => undefined, () => undefined)
		return run
	}

	/** Persist the index atomically: write a sibling temp file, then rename. */
	async #flush() {
		const payload = JSON.stringify({ version: STORE_FORMAT_VERSION, apps: [...this.entries.values()] }, null, '\t')
		// 临时名必须**每个写入者都不同**（pid + 计数器）。固定名 `${indexPath}.tmp` 时，
		// 两个指向同一 dataDir 的实例会互相 rename 掉对方的临时文件：实测 40 轮交错 flush
		// 直接抛 ENOENT，最终索引只剩一条。这与 atomicWrite 用的是同一套命名。
		const tmp = `${this.indexPath}.tmp.${process.pid}.${tempCounter++}`
		await mkdir(dirname(this.indexPath), { recursive: true })
		try {
			await writeFile(tmp, payload, 'utf8')
			await rename(tmp, this.indexPath)
		} catch (error) {
			// 与 atomicWrite 一致：失败时把自己那个临时文件收掉，不留垃圾。
			await rm(tmp, { force: true }).catch(() => {})
			throw error
		}
	}

	/** mtime in ms, or null when the file is absent. Clocks before the epoch read as 0. */
	async #mtimeMs(path) {
		const info = await this.#fileInfo(path)
		return info === null ? null : info.mtime
	}

	/** `{ mtime, size }` for an existing file, or null. One stat, two answers. */
	async #fileInfo(path) {
		try {
			// **不要 floor 到整毫秒。** "有未发布改动"与 publish 的"读中被改写"两道闸都只靠这个
			// 数字比较，而同一毫秒内的两次写入在 APFS 上很常见（代理实测：200 次连续写里只有
			// 20 个不同的 floor(ms)）—— floor 之后"内容变了"会被判成"没变"，用户的改动既不
			// 上线、也不会出现"发布"按钮，界面上一切正常。用 bigint 纳秒除以 1e6 拿到带小数的
			// 毫秒：整数部分只有 1.7e12，小数部分是有效的亚毫秒精度，仍在 Number 的安全范围内。
			const info = await stat(path, { bigint: true })
			return { mtime: mtimeMsOf(info), size: Number(info.size) || 0 }
		} catch {
			return null
		}
	}

	/**
	 * Whether the working copy is ahead of the snapshot.
	 *
	 * Derived on every read rather than stored: a stored flag goes stale the
	 * instant an agent writes the file. `(working copy, no stamp)` counts as
	 * unpublished, which is the safe direction.
	 *
	 * The one exception is an app that has never held a document at all: a
	 * freshly created row and an EMPTY working copy mean "not started yet", and
	 * lighting the 有未发布改动 badge over an empty scaffold would be a lie the
	 * user cannot act on. The moment any bytes land, the normal rules apply.
	 *
	 * The comparison is strictly greater, and that is load-bearing:
	 * `ensureWorkingCopy` stamps `published_at` from the very mtime of the file
	 * it just materialised, so an equality check would call a fresh copy dirty.
	 */
	async hasUnpublishedChanges(entry) {
		const info = await this.#fileInfo(this.workingCopyPath(entry.miniapp_id))
		if (info === null) return false
		if (entry.published_at === null) return info.size > 0
		return info.mtime > entry.published_at
	}

	/** The wire shape. Deliberately never carries the HTML body. */
	async project(entry) {
		return {
			miniapp_id: entry.miniapp_id,
			name: entry.name,
			description: entry.description,
			icon: entry.icon,
			html_size: entry.html_size,
			published_at: entry.published_at,
			created_at: entry.created_at,
			updated_at: entry.updated_at,
			source_session_id: entry.source_session_id,
			// 工作副本总是存在（create 就会落盘），所以路径总是可给。它不是输入 ——
			// 客户端只把它读回去组织「继续迭代」的指令，永远不自己拼路径。
			source_path: this.workingCopyPath(entry.miniapp_id),
			has_unpublished_changes: await this.hasUnpublishedChanges(entry)
		}
	}

	/** Every app, most recently touched first. */
	async list() {
		await this.load()
		const sorted = [...this.entries.values()].sort((a, b) => b.updated_at - a.updated_at)
		return Promise.all(sorted.map((entry) => this.project(entry)))
	}

	/** One app, or a 404. */
	async get(miniappId) {
		await this.load()
		const entry = this.entries.get(miniappId)
		if (entry === undefined) throw new MiniAppNotFound(`mini-app ${miniappId} not found`)
		return entry
	}

	/** One app in wire shape. */
	async getProjected(miniappId) {
		return this.project(await this.get(miniappId))
	}

	/** Validate the human-facing fields, returning the canonical form. */
	static validateMeta(input, { partial = false } = {}) {
		const out = {}
		if (input.name !== undefined || !partial) {
			const name = trimmed(input.name)
			if (name === undefined) throw new MiniAppBadRequest('name 必须是字符串')
			if (name.length === 0) throw new MiniAppBadRequest('name 不能为空')
			if (charCount(name) > NAME_MAX_CHARS) throw new MiniAppBadRequest(`name 不能超过 ${NAME_MAX_CHARS} 个字符`)
			out.name = name
		}
		if (input.description !== undefined) {
			const description = trimmed(input.description) ?? ''
			if (charCount(description) > DESCRIPTION_MAX_CHARS) throw new MiniAppBadRequest(`description 不能超过 ${DESCRIPTION_MAX_CHARS} 个字符`)
			out.description = description
		}
		if (input.icon !== undefined) {
			// A blank icon clears back to null so the card falls back to the default
			// glyph instead of rendering an empty box.
			const icon = trimmed(input.icon) ?? ''
			if (icon.length === 0) out.icon = null
			else if (charCount(icon) > ICON_MAX_CHARS) throw new MiniAppBadRequest(`icon 不能超过 ${ICON_MAX_CHARS} 个字符`)
			else out.icon = icon
		}
		return out
	}

	/** Validate a document body, returning it byte-for-byte unchanged. */
	static validateHtml(html) {
		if (typeof html !== 'string') throw new MiniAppBadRequest('html 必须是字符串')
		if (html.trim().length === 0) throw new MiniAppBadRequest('html 不能为空')
		if (Buffer.byteLength(html, 'utf8') > HTML_MAX_BYTES) {
			throw new MiniAppBadRequest(`html 超过 ${HTML_MAX_BYTES} 字节上限`)
		}
		// Never trimmed on the way in: leading whitespace inside a <pre> belongs
		// to the author, and the byte count reported back must be what was stored.
		return html
	}

	/**
	 * Create an app.
	 *
	 * `html` is optional: the "build me a mini-app" flow creates the row and the
	 * working copy first, hands the agent an absolute path, and publishes later.
	 * An app created without a document has no snapshot, so nothing is servable
	 * until it is published — which is why `published_at` starts null.
	 */
	async create(input) {
		await this.load()
		const meta = MiniAppStore.validateMeta(input)
		const html = input.html === undefined ? undefined : MiniAppStore.validateHtml(input.html)
		const now = Date.now()
		const miniappId = newMiniAppId()
		const entry = normaliseEntry({
			miniapp_id: miniappId,
			name: meta.name,
			description: meta.description ?? '',
			icon: meta.icon ?? null,
			html_size: html === undefined ? 0 : Buffer.byteLength(html, 'utf8'),
			published_at: html === undefined ? null : now,
			created_at: now,
			updated_at: now,
			source_session_id: typeof input.source_session_id === 'string' ? input.source_session_id : null
		})
		// 带 html 的 create **就是**一次发布（快照与工作副本同时落盘），所以它必须过
		// 与 `publish` 同一道"这是不是 HTML 文档"的闸：否则一段笔记/JSON/栈回溯
		// 会成为线上文档。`miniapp_create({html})` 与 `POST /apps` 都走这里。
		if (html !== undefined) {
			const { looksLikeHtmlDocument } = await import('./validate.js')
			if (!looksLikeHtmlDocument(html)) {
				throw new MiniAppBadRequest('这份内容不是 HTML 文档，不能作为小程序发布')
			}
		}
		return this.#serial(async () => {
			await mkdir(this.appDir(miniappId), { recursive: true })
			// Seed the working copy from the document when one was supplied, so
			// "continue iterating" always has something to open.
			const seed = html ?? ''
			const working = this.workingCopyPath(miniappId)
			await atomicWrite(working, seed)
			if (html !== undefined) await atomicWrite(this.snapshotPath(miniappId), html)
			entry.published_at = html === undefined ? null : await this.#mtimeMs(working)
			this.entries.set(miniappId, entry)
			await this.#flush()
			return this.project(entry)
		})
	}

	/** Update metadata, and replace the snapshot when a new body is supplied. */
	async update(miniappId, input) {
		await this.load()
		const entry = await this.get(miniappId)
		const meta = MiniAppStore.validateMeta(input, { partial: true })
		const html = input.html === undefined ? undefined : MiniAppStore.validateHtml(input.html)
		if (Object.keys(meta).length === 0 && html === undefined) {
			throw new MiniAppBadRequest('更新请求至少要包含一个字段')
		}
		return this.#serial(async () => {
			if (meta.name !== undefined) entry.name = meta.name
			if (meta.description !== undefined) entry.description = meta.description
			if (meta.icon !== undefined) entry.icon = meta.icon
			if (html !== undefined) {
				// Writing a body through `update` IS a publish. Stamping the publish
				// instant from the bytes we just wrote, and refreshing the working
				// copy to the same document, is what keeps the two layers from
				// disagreeing about which one is newer.
				//
				// **这道闸与 publish 是同一道。** 带 html 的 update 同样会把正文写进
				// snapshot，也就是"发布"，所以它必须过同一个 `looksLikeHtmlDocument`：
				// 否则一段 TODO 笔记、一个 JSON、一段栈回溯都能顶掉一个正在用的工具
				// （`publish` 的注释里写着这条，而这里曾经是它的后门）。
				const { looksLikeHtmlDocument } = await import('./validate.js')
				if (!looksLikeHtmlDocument(html)) {
					throw new MiniAppBadRequest('这份内容不是 HTML 文档，不能作为小程序发布')
				}
				await atomicWrite(this.snapshotPath(miniappId), html)
				await atomicWrite(this.workingCopyPath(miniappId), html)
				entry.html_size = Buffer.byteLength(html, 'utf8')
				entry.published_at = await this.#mtimeMs(this.workingCopyPath(miniappId))
			}
			entry.updated_at = Date.now()
			await this.#flush()
			return this.project(entry)
		})
	}

	/**
	 * Ensure the working copy exists, materialising it from the snapshot when
	 * absent, and answer its absolute path.
	 *
	 * Idempotent, and never called by the serve path or at boot: a startup sweep
	 * would read every document and write every file on every boot and could not
	 * fail closed — a full disk must not take the whole library down.
	 */
	async ensureWorkingCopy(miniappId) {
		await this.load()
		const entry = await this.get(miniappId)
		return this.#serial(async () => {
			const working = this.workingCopyPath(miniappId)
			const existing = await this.#mtimeMs(working)
			if (existing === null) {
				const snapshot = await this.readSnapshot(miniappId).catch(() => undefined)
				await mkdir(this.appDir(miniappId), { recursive: true })
				await atomicWrite(working, snapshot ?? '')
				// Stamp AFTER the write, from the file's own mtime. Stamping first
				// would race the write: a file landing a millisecond late would make
				// the app claim unpublished changes the moment it is opened.
				//
				// **只在真的有快照时才盖戳。** 没有快照却盖了 `published_at`，wire 上就会出现
				// "说发布了、`/serve/{id}` 却 404"（`published_at` 的契约是"从未发布时为 null"），
				// 而"工作副本被清掉、还没发布过"正是这条路最常见的入口。
				if (snapshot !== undefined) entry.published_at = await this.#mtimeMs(working)
				await this.#flush()
			}
			return working
		})
	}

	/** The published snapshot body, or undefined when nothing is published yet. */
	async readSnapshot(miniappId) {
		try {
			return await readFile(this.snapshotPath(miniappId), 'utf8')
		} catch (error) {
			if (error?.code === 'ENOENT') return undefined
			throw error
		}
	}

	/** The working copy body, if it exists. */
	async readWorkingCopy(miniappId) {
		try {
			return await readFile(this.workingCopyPath(miniappId), 'utf8')
		} catch (error) {
			if (error?.code === 'ENOENT') return undefined
			throw error
		}
	}

	/**
	 * Replace the working copy with `html`.
	 *
	 * The caller validates the body first. This is the only way an editing
	 * session reaches the source: the working copy lives outside every session
	 * workspace, so the harness file sandbox refuses a direct `write` there —
	 * and a plugin writing its own data directory through its own tool is both
	 * the honest and the safe route, because the path is derived from the id
	 * and is never taken from the caller.
	 *
	 * `updated_at` moves, because "recently iterated" is what the library sorts
	 * cards by. The unpublished flag is unaffected: it compares the file's mtime
	 * against `published_at`, not this column.
	 */
	async writeWorkingCopy(miniappId, html) {
		await this.load()
		const entry = await this.get(miniappId)
		return this.#serial(async () => {
			await atomicWrite(this.workingCopyPath(miniappId), html)
			entry.updated_at = Date.now()
			await this.#flush()
			return this.project(entry)
		})
	}

	/**
	 * Promote the working copy into the served snapshot.
	 *
	 * Four gates, all of them earned by a real failure mode:
	 *   1. no working copy            → 400 "nothing to publish" (a state the user
	 *      can fix by iterating, not a missing app and not a server fault);
	 *   2. mtime changed across the read → 400, because nothing orders writes to
	 *      the working copy (a shell `> working.html` truncates before it writes)
	 *      and reading across a write would promote half a document;
	 *   3. not valid UTF-8            → 400;
	 *   4. does not look like an HTML document → 400, because otherwise a plan, a
	 *      notes file or a stack trace left behind by an errored turn would
	 *      replace a working tool, and there is no previous snapshot to fall back
	 *      to.
	 */
	async publish(miniappId) {
		await this.load()
		const entry = await this.get(miniappId)
		const working = this.workingCopyPath(miniappId)
		const nothingToPublish = () => new MiniAppBadRequest('这个小程序还没有工作副本，先让它迭代出内容再发布')

		const before = await this.#mtimeMs(working)
		if (before === null) throw nothingToPublish()
		const bytes = await readFile(working)
		const after = await this.#mtimeMs(working)
		if (after === null) throw nothingToPublish()
		if (after !== before) {
			throw new MiniAppBadRequest('工作副本在读取过程中被改写了，可能只读到半个文档；等当前这一轮写完再发布')
		}
		const html = bytes.toString('utf8')
		if (Buffer.from(html, 'utf8').compare(bytes) !== 0) {
			throw new MiniAppBadRequest('工作副本不是合法的 UTF-8 文本，小程序文档必须是 UTF-8 的 HTML 文件')
		}
		MiniAppStore.validateHtml(html)
		const { looksLikeHtmlDocument } = await import('./validate.js')
		if (!looksLikeHtmlDocument(html)) {
			throw new MiniAppBadRequest('工作副本看起来不是 HTML 文档；如果确实还没写完，让会话先把它写完')
		}
		return this.#serial(async () => {
			await atomicWrite(this.snapshotPath(miniappId), html)
			entry.html_size = Buffer.byteLength(html, 'utf8')
			// Stamp the mtime of the bytes we actually read, never `Date.now()`.
			// A later timestamp would mark a write that landed during the read as
			// already published, so the user's newest edit would neither ship nor
			// ever offer a 发布 button again.
			entry.published_at = before
			entry.updated_at = Date.now()
			await this.#flush()
			return this.project(entry)
		})
	}

	/** Delete an app and both of its trees. The row goes first: that is the fact the user asked to change. */
	async remove(miniappId) {
		await this.load()
		const entry = await this.get(miniappId)
		const snapshot = this.snapshotPath(miniappId)
		return this.#serial(async () => {
			// **先删文件、最后删行。** 反过来（先删行再删文件）时，任何一次 rm 失败
			// （权限、占用、磁盘错）都会留下"用户以为删了、库里也没有了、`miniapp_delete`
			// 再调只会 404，而 `/serve/{id}` 仍在直出这份文档"的状态 —— 收不回来。
			// 这个顺序下最坏是"文件删了、行还在"，用户再删一次即可，且不会泄漏直出。
			await rm(this.appDir(miniappId), { recursive: true, force: true })
			await rm(snapshot, { force: true })
			this.entries.delete(miniappId)
			await this.#flush()
			return { miniapp_id: entry.miniapp_id, name: entry.name }
		})
	}

	/**
	 * 读用户偏好（目前只有一个键：固定到会话标题栏的那一个小程序）。
	 *
	 * **损坏时当成"没有偏好"，绝不拒绝启动。** 这条与 `index.json` 的策略刻意不同：
	 * index.json 是库的唯一权威，读坏了必须 fail loud（否则一次写入就会把整个库
	 * 覆写成空的）；而 prefs 只影响标题栏上一颗图标 —— 为它让整个插件起不来，
	 * 是拿大炮打蚊子。
	 */
	async readPrefs() {
		const empty = { pinned_app_id: null }
		let text
		try {
			text = await readFile(this.prefsPath, 'utf8')
		} catch {
			return empty
		}
		try {
			const parsed = JSON.parse(text)
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
			const pinned = parsed.pinned_app_id
			return { pinned_app_id: typeof pinned === 'string' && isMiniAppId(pinned) ? pinned : null }
		} catch {
			return empty
		}
	}

	/**
	 * 写用户偏好。
	 *
	 * 只接受合法 id 或 null：固定一个已经不存在的 id 是允许的（用户可能只是暂时
	 * 删了同名的），但形状不对的值一律归成 null，别把垃圾写进盘里。
	 */
	async writePrefs(input) {
		const pinned = input !== null && typeof input === 'object' ? input.pinned_app_id : null
		const next = { pinned_app_id: typeof pinned === 'string' && isMiniAppId(pinned) ? pinned : null }
		await atomicWrite(this.prefsPath, JSON.stringify(next, null, '\t'))
		return next
	}

	/** Every app id currently on disk, for diagnostics. */
	async idsOnDisk() {
		await mkdir(this.appsDir, { recursive: true })
		const dirents = await readdir(this.appsDir, { withFileTypes: true })
		return dirents.filter((d) => d.isDirectory()).map((d) => d.name)
	}
}

/**
 * Write bytes through a unique temp file and a rename.
 *
 * A killed process leaves either the previous complete file or the new complete
 * file — never a spliced one. The pid plus a counter keeps the temp name unique
 * without a global lock.
 */
let tempCounter = 0
export async function atomicWrite(path, contents) {
	await mkdir(dirname(path), { recursive: true })
	const tmp = `${path}.tmp.${process.pid}.${tempCounter++}`
	try {
		await writeFile(tmp, contents, 'utf8')
		await rename(tmp, path)
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => undefined)
		throw error
	}
}

/** Content digest, used only for diagnostics and import de-duplication hints. */
export function digestOf(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex')
}
