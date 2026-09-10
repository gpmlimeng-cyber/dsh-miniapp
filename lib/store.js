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
				for (const row of rows) {
					if (row && isMiniAppId(row.miniapp_id)) this.entries.set(row.miniapp_id, normaliseEntry(row))
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
		const tmp = `${this.indexPath}.tmp`
		await mkdir(dirname(this.indexPath), { recursive: true })
		await writeFile(tmp, payload, 'utf8')
		await rename(tmp, this.indexPath)
	}

	/** mtime in ms, or null when the file is absent. Clocks before the epoch read as 0. */
	async #mtimeMs(path) {
		const info = await this.#fileInfo(path)
		return info === null ? null : info.mtime
	}

	/** `{ mtime, size }` for an existing file, or null. One stat, two answers. */
	async #fileInfo(path) {
		try {
			const info = await stat(path)
			return {
				mtime: Number.isFinite(info.mtimeMs) && info.mtimeMs > 0 ? Math.floor(info.mtimeMs) : 0,
				size: info.size
			}
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
				entry.published_at = await this.#mtimeMs(working)
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
			this.entries.delete(miniappId)
			await this.#flush()
			await rm(this.appDir(miniappId), { recursive: true, force: true })
			await rm(snapshot, { force: true })
			return { miniapp_id: entry.miniapp_id, name: entry.name }
		})
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
