// dsh-miniapp — import validation.
//
// Ported from `crates/backend/nomifun-miniapp/src/validation.rs`. The rule set
// is derived from the RUNTIME, not from taste: a mini-app document runs inside
// an iframe whose CSP says `sandbox` WITHOUT `allow-same-origin`, and the serve
// route hands out exactly one document. So a mini-app has no cookies, no
// same-origin fetch, no service worker, no reachable `window.parent`, storage
// APIs that may throw, no build step, and no server.
//
// This is a BOUNDED LEXICAL SCAN, not a parser. It does not build a DOM, so it
// cannot tell a reference inside an HTML comment or a JS string from a real one,
// and attribute values are matched lexically. Every rule therefore errs toward
// REPORTING rather than silently importing something broken; apart from the one
// autofix below it never rewrites the document.
//
// Findings carry `rule_id` + `severity` + optional structured `detail`. No prose:
// the wording lives in the client's i18n table, keyed by rule id, so one id list
// drives both the user-facing report and the repair instructions handed to a
// model.

/**
 * Every rule id this version can emit. Mirrored by the client's copy table.
 *
 * This list is a CLOSED SET and a test pins it in both directions: nothing
 * outside it may be emitted, and every member must be reachable. That is why
 * upstream's `no_root_document` is deliberately ABSENT here — it is a
 * directory-import rule (a folder with no `index.html`), and this port imports
 * a single file only. Listing a rule that no code path can produce would make
 * the list a description of intentions rather than of behaviour. Add it back
 * together with folder import, not before; the client already carries its copy.
 */
export const IMPORT_RULE_IDS = [
	'empty_payload',
	'size_over_limit',
	'not_html',
	'fragment_not_document',
	'local_ref_unsupported',
	'dev_server_ref',
	'framework_source_entry',
	'server_template_markers',
	'esm_bare_specifier',
	'external_cdn_ref',
	'web_storage_use',
	'nested_iframe_embed'
]

/** Severity tiers, in report order. */
export const SEVERITY_ORDER = ['fatal', 'autofix', 'warning']

/** Document size ceiling, in bytes. */
export const HTML_MAX_BYTES = 4 * 1024 * 1024
/** Bounded directory walk (an import source may be a folder). */
export const MAX_BUNDLE_ENTRIES = 500
export const MAX_BUNDLE_DEPTH = 6
/** Attribute values worth treating as references. */
const REFERENCE_ATTRIBUTES = ['src', 'href', 'poster', 'data-src']
/** Hosts that only resolve on the machine that wrote the file. */
const DEV_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']
/** Markers that need a server-side renderer to become HTML. */
const SERVER_TEMPLATE_MARKERS = ['<?php', '<?=', '<%', '{%', '@model', 'th:text=']
/** Source entries that need a bundler before a browser can run them. */
const FRAMEWORK_ENTRY_PATTERNS = [/\/src\/main\.(ts|tsx|js|jsx)/i, /src=["']\/src\//i]
/** File extensions that prove a folder holds an unbuilt framework project. */
const FRAMEWORK_SOURCE_EXTENSIONS = ['.vue', '.svelte', '.tsx', '.jsx']
/** The only document extensions an import accepts, checked BEFORE reading. */
export const DOCUMENT_EXTENSIONS = ['html', 'htm']

function finding(ruleId, severity, detail) {
	return detail === undefined
		? { rule_id: ruleId, severity }
		: { rule_id: ruleId, severity, detail }
}

/**
 * Whether a document is recognisably a web page.
 *
 * Deliberately loose: any of the common document or block-level openings counts.
 * A pasted script, a JSON blob or a stack trace does not.
 */
export function looksLikeHtmlDocument(html) {
	if (typeof html !== 'string') return false
	const lower = html.toLowerCase()
	return ['<!doctype html', '<html', '<body', '<div', '<h1', '<p>'].some((needle) => lower.includes(needle))
}

/** Whether the document already has a root element, i.e. is not a bare fragment. */
function hasDocumentShell(html) {
	const lower = html.toLowerCase()
	return lower.includes('<html') || lower.includes('<body')
}

/** Collect `name="value"` / `name='value'` pairs for the reference attributes. */
function collectReferences(html) {
	const references = []
	const pattern = new RegExp(`(${REFERENCE_ATTRIBUTES.join('|')})\\s*=\\s*("([^"]*)"|'([^']*)')`, 'gi')
	let match
	while ((match = pattern.exec(html)) !== null) {
		const value = (match[3] ?? match[4] ?? '').trim()
		if (value.length > 0) references.push(value)
	}
	return references
}

/**
 * A reference that needs no further examination: empty, a fragment, or a scheme
 * that resolves without any file or host of ours (`data:`, `mailto:`, `tel:`,
 * `javascript:`). Everything else is either a network reference or a local one.
 */
function isBenignReference(value) {
	if (value.length === 0) return true
	if (value === '#') return true
	const lower = value.toLowerCase()
	return lower.startsWith('data:') || lower.startsWith('mailto:') || lower.startsWith('tel:') || lower.startsWith('javascript:')
}

/** A reference that only works while the author's dev server is running. */
function isDevServerReference(value) {
	const lower = value.toLowerCase()
	return DEV_HOSTS.some((host) => lower.includes(host))
}

/** An absolute or protocol-relative network reference. */
function isNetworkReference(value) {
	const lower = value.toLowerCase()
	return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')
}

/** Detail strings shown to the user; capped so one bad file cannot flood the report. */
const MAX_DETAIL_ITEMS = 8

function summarise(items) {
	if (items.length <= MAX_DETAIL_ITEMS) return items.join('、')
	return `${items.slice(0, MAX_DETAIL_ITEMS).join('、')} … (+${items.length - MAX_DETAIL_ITEMS})`
}

/**
 * Run every rule over one candidate document.
 *
 * @param html - the candidate document text.
 * @param siblings - payload-relative sibling paths, when the source was a folder.
 * @returns `{ findings, blocked }` — `blocked` is exactly "some finding is fatal",
 *   so the caller cannot disagree with the UI about whether the import may proceed.
 */
export function validateImport(html, siblings = []) {
	const findings = []

	if (typeof html !== 'string' || html.trim().length === 0) {
		// An empty payload short-circuits every other rule: there is nothing to scan.
		return { findings: [finding('empty_payload', 'fatal')], blocked: true }
	}

	const bytes = Buffer.byteLength(html, 'utf8')
	if (bytes > HTML_MAX_BYTES) {
		findings.push(finding('size_over_limit', 'fatal', String(bytes)))
	}

	if (!looksLikeHtmlDocument(html)) {
		// Not a document at all — scanning it for references would produce noise.
		return { findings: [finding('not_html', 'fatal')], blocked: true }
	}

	if (!hasDocumentShell(html)) {
		// The one thing NomiFun can fix by itself: a fragment gets a document shell.
		findings.push(finding('fragment_not_document', 'autofix'))
	}

	const references = collectReferences(html)
	const localReferences = []
	let sawCdn = false
	let sawDev = false

	for (const value of references) {
		if (isBenignReference(value)) continue
		const lower = value.toLowerCase()

		if (isNetworkReference(value)) {
			if (isDevServerReference(value)) {
				sawDev = true
				findings.push(finding('dev_server_ref', 'fatal', value))
			} else {
				sawCdn = true
			}
			continue
		}

		// Everything left is a relative or absolute local path. The serve route
		// hands out ONE document, so a sibling file is unreachable even when it
		// travelled along with the import.
		localReferences.push(value)
	}

	// A dev-server URL can also hide outside an attribute — `fetch('http://localhost:8000/api')`.
	if (!sawDev) {
		for (const host of DEV_HOSTS) {
			if (html.toLowerCase().includes(`//${host}`)) {
				findings.push(finding('dev_server_ref', 'fatal', `//${host}`))
				sawDev = true
				break
			}
		}
	}

	if (localReferences.length > 0) {
		findings.push(finding('local_ref_unsupported', 'fatal', summarise(localReferences)))
	}

	if (sawCdn && !sawDev) {
		findings.push(finding('external_cdn_ref', 'warning'))
	}

	const frameworkSignals = FRAMEWORK_ENTRY_PATTERNS.some((pattern) => pattern.test(html))
	const siblingSignal = siblings.some((path) => FRAMEWORK_SOURCE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext)))
	if (frameworkSignals || siblingSignal) {
		findings.push(finding('framework_source_entry', 'fatal'))
	}

	const markers = SERVER_TEMPLATE_MARKERS.filter((marker) => html.includes(marker))
	if (markers.length > 0) {
		// `{{ }}` alone is NOT a marker: Vue, Alpine and Handlebars all use it
		// client-side, and crying wolf on those would be wrong far more often
		// than it is right.
		findings.push(finding('server_template_markers', 'fatal', markers.join('、')))
	}

	const bareSpecifier = firstBareModuleSpecifier(html)
	if (bareSpecifier !== undefined) {
		findings.push(finding('esm_bare_specifier', 'fatal', bareSpecifier))
	}

	const lower = html.toLowerCase()
	if (lower.includes('localstorage') || lower.includes('sessionstorage') || lower.includes('indexeddb')) {
		// Never fatal: an app that merely uses storage as a convenience still works,
		// it just may throw inside an opaque origin.
		findings.push(finding('web_storage_use', 'warning'))
	}

	if (lower.includes('<iframe')) {
		findings.push(finding('nested_iframe_embed', 'warning'))
	}

	return { findings, blocked: findings.some((f) => f.severity === 'fatal') }
}

/**
 * The first bare module specifier in a module script that no import map covers.
 *
 * Only reported when there is no `type="importmap"`: with a map present, a bare
 * specifier is exactly what the map is for.
 */
function firstBareModuleSpecifier(html) {
	const lower = html.toLowerCase()
	if (!lower.includes('type="module"') && !lower.includes("type='module'")) return undefined
	if (lower.includes('type="importmap"') || lower.includes("type='importmap'")) return undefined
	const match = /from\s+["']([^"']+)["']/.exec(html)
	if (match === null) return undefined
	const specifier = match[1]
	if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined
	if (specifier.includes('://') || specifier.startsWith('data:')) return undefined
	return specifier
}

/** Wrap a bare fragment into a complete document. Returns the new text. */
export function wrapFragment(html) {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
${html}
</body>
</html>
`
}

/**
 * Apply the automatic fixes a report asked for.
 *
 * @returns `{ html, applied }` where `applied` lists only the rule ids that were
 *   actually applied — never the ones the report merely hoped for.
 */
export function applyFixes(html, report) {
	let out = html
	const applied = []
	if (report.findings.some((f) => f.rule_id === 'fragment_not_document')) {
		out = wrapFragment(out)
		applied.push('fragment_not_document')
	}
	return { html: out, applied }
}

/** Group findings by severity, preserving both the tier order and the input order. */
export function groupFindings(findings) {
	const groups = []
	for (const severity of SEVERITY_ORDER) {
		const items = findings.filter((f) => f.severity === severity)
		if (items.length > 0) groups.push({ severity, findings: items })
	}
	// An unknown tier is kept in its own group rather than dropped: an unrendered
	// finding is still something the user needs to know.
	const known = new Set(SEVERITY_ORDER)
	const unknown = findings.filter((f) => !known.has(f.severity))
	if (unknown.length > 0) groups.push({ severity: 'other', findings: unknown })
	return groups
}

/** Best-effort display name for a candidate: `req.name` → `<title>` → file stem. */
export function suggestName(html, fileName) {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? '')
	const title = match?.[1]?.trim()
	if (title !== undefined && title.length > 0) return clampName(title)
	// Take the stem of the BASENAME: callers may hand us a full path, and
	// `/tmp/我的工具.html` must not become `/tmp/我的工具`.
	const base = String(fileName ?? '').split(/[/\\]/).pop() ?? ''
	const stem = base.replace(/\.[^.]*$/, '').trim()
	if (stem.length > 0) return clampName(stem)
	return '导入的小程序'
}

/**
 * Truncate a name to the store's limit instead of rejecting it.
 *
 * A `<title>` or a file name is not under anyone's control, and "you were told
 * this would import" must not turn into a refusal at the last step.
 */
export function clampName(name, max = 100) {
	const points = Array.from(name)
	if (points.length <= max) return name
	return points.slice(0, max).join('')
}

/** HTML-escape a value for embedding in an attribute or text node. */
export function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}
