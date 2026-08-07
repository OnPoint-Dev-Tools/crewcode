import { createPatch } from 'diff'

/**
 * Tool names across the providers we ship (Claude bridge via pi, opencode,
 * codex apply_patch, generic str_replace_editor) that mutate a file on disk.
 * Anything not on this list is ignored by the per-turn change tracker.
 *
 * Stored lowercase because bridge providers (opencode, pi) emit lowercase names
 * while legacy/codex names vary in casing.
 */
const FILE_EDIT_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'create_file',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'apply_patch',
  'patch',
  'file_write',
  'file_edit',
])

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v) return v
  }
  return null
}

const READ_ONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'list', 'ls', 'webfetch', 'web_fetch',
  'web_search', 'websearch', 'search', 'bash', 'shell',
  'commandexecution', 'execute', 'run',
])

const MUTATION_PAYLOAD_KEYS = [
  'content', 'text',
  'newString', 'new_string', 'newText', 'new_text',
  'oldString', 'old_string', 'oldText', 'old_text',
  'diff', 'patch', 'changes', 'code', 'edits',
  'replacement', 'insert', 'new', 'old', 'newStr', 'oldStr',
]

function hasFileMutationPayload(args: Record<string, unknown>): boolean {
  return MUTATION_PAYLOAD_KEYS.some(k => args[k] !== undefined)
}

export function isFileEditTool(name: string, args: unknown): boolean {
  if (typeof name !== 'string') return false
  const lower = name.toLowerCase()
  if (FILE_EDIT_TOOLS.has(lower)) return true
  if (READ_ONLY_TOOLS.has(lower)) return false
  const a = asRecord(args)
  if (!a) return false
  // Fallback: any tool whose args contain both a target path and mutation
  // payload is treated as a file edit. This catches provider-specific names
  // like pi's "modifies" or custom str_replace variants without hard-coding
  // every possible spelling.
  return pathField(a) !== null && hasFileMutationPayload(a)
}

/**
 * Pull the workspace-relative file path out of a tool-call's `args` object.
 * Tools name the field differently — we try the common spellings in order.
 * Returns null if we can't identify a single target file (e.g. shell calls).
 */
export function extractFilePathFromToolArgs(toolName: string, args: unknown): string | null {
  if (!toolName || typeof toolName !== 'string') return null
  if (!args || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  if (!isFileEditTool(toolName, a)) return null

  // Some bridges (codex) package a multi-file patch as `{ changes: [{ path, diff }] }`.
  const paths = extractFilePathsFromToolArgs(toolName, args)
  return paths[0] ?? null
}

/**
 * Return every target path named by a file-mutating tool call. Single-file
 * tools return one path; patch tools may expose a `changes` array.
 */
export function extractFilePathsFromToolArgs(toolName: string, args: unknown): string[] {
  if (!toolName || typeof toolName !== 'string') return []
  if (!args || typeof args !== 'object') return []
  const a = args as Record<string, unknown>
  if (!isFileEditTool(toolName, a)) return []

  const paths: string[] = []
  const add = (p: string | null): void => {
    if (p && !paths.includes(p)) paths.push(p)
  }

  // Some bridges package a multi-file patch as `{ changes: [{ path, diff }] }`.
  if (Array.isArray(a.changes)) {
    for (const change of a.changes) {
      if (!change || typeof change !== 'object') continue
      add(pathField(change as Record<string, unknown>))
    }
  }

  add(pathField(a))
  return paths
}

export function pathField(obj: Record<string, unknown>): string | null {
  return firstString(
    obj.file_path,
    obj.filePath,
    obj.FilePath,
    obj.filepath,
    obj.path,
    obj.file,
    obj.filename,
    obj.file_name,
    obj.target_file,
    obj.targetFile,
    obj.targetfile,
  )
}

/**
 * Build a git-style unified diff from a pair of file snapshots. PierreDiff's
 * parser requires `diff --git`, `--- a/...`, `+++ b/...`, and an `index` line.
 * Returns an empty string when the contents are identical so callers can
 * suppress no-op tool calls.
 */
export function buildUnifiedDiff(relPath: string, before: string, after: string): string {
  if (before === after) return ''
  const isNew     = before === ''
  const isDeleted = after === ''
  const raw = createPatch(relPath, before, after, '', '', { context: 3 })
  // Strip the non-git `Index:` / `===` header that `diff` adds and drop the
  // old `---` / `+++` lines so we can emit git-style `a/` and `b/` prefixes.
  const body = raw
    .split('\n')
    .filter(line => !line.startsWith('Index:') && !line.startsWith('===') && !line.startsWith('---') && !line.startsWith('+++'))
    .join('\n')
  const header = isNew
    ? [
        `diff --git a/${relPath} b/${relPath}`,
        'new file mode 100644',
        'index 0000000..1111111 100644',
        '--- /dev/null',
        `+++ b/${relPath}`,
      ]
    : isDeleted
      ? [
          `diff --git a/${relPath} b/${relPath}`,
          'deleted file mode 100644',
          'index 1111111..0000000 100644',
          `--- a/${relPath}`,
          '+++ /dev/null',
        ]
      : [
          `diff --git a/${relPath} b/${relPath}`,
          'index 1111111..2222222 100644',
          `--- a/${relPath}`,
          `+++ b/${relPath}`,
        ]
  return `${header.join('\n')}\n${body}`
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? v as Record<string, unknown> : null
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Count `+` / `-` lines in a unified diff, skipping the `+++`/`---` headers. */
export function diffStats(patch: string | undefined): { added: number; removed: number } {
  if (!patch) return { added: 0, removed: 0 }
  let added = 0, removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

/** Ensure provider-emitted patches include git-style headers Pierre can parse. */
export function normalizePatchForPierre(path: string, raw: string): string {
  if (!raw) return raw
  const name = path.replace(/^\/+/, '') || 'file'
  const cleaned = raw
    .split('\n')
    .filter(line => !line.startsWith('Index:') && !line.startsWith('==='))
    .join('\n')
  if (/^diff --git /m.test(cleaned)) return cleaned
  const header = `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n`
  const withGitHeader = cleaned.startsWith(`diff --git a/${name} b/${name}\n`) ? cleaned : header + cleaned
  return withGitHeader
    .replace(/^--- .+$/m, `--- a/${name}`)
    .replace(/^\+\+\+ .+$/m, `+++ b/${name}`)
}

export interface ProviderPatchChange {
  path:  string
  patch: string
}

/**
 * A real unified diff has at least one `@@ ... @@` hunk header or a
 * `diff --git` line. Several tools surface a human-readable, line-numbered
 * preview (e.g. `  72 | text`) under `diff` instead — Pierre cannot parse that,
 * so we must reject it and let the git fallback produce a true patch.
 */
function looksLikeUnifiedDiff(raw: string): boolean {
  return /^diff --git /m.test(raw) || /^@@ .* @@/m.test(raw)
}

// One body line of pi's preview format: `<marker><right-aligned line#> <content>`.
// Marker is `+` (added), `-` (removed), or a leading space (context). Examples:
// "  38 import x", "+ 42 added", "+199 added", "- 12 removed".
const PREVIEW_LINE = /^([+\- ])\s*(\d+) ?(.*)$/
// Elision/gap between non-adjacent hunks, e.g. "     ...".
const PREVIEW_GAP = /^\s*\.\.\.\s*$/

/**
 * pi/crewcoder edit tools surface a line-numbered preview under `details.diff`
 * instead of a unified diff:
 *
 *     ...
 *   41 context line
 *   + 42 added line
 *   - 42 removed line
 *
 * Pierre's parser needs real `@@` hunks, so convert the preview into a unified
 * diff. Returns null when the text isn't recognizably this format.
 */
export function parsePreviewDiff(path: string, raw: string): string | null {
  if (!raw || looksLikeUnifiedDiff(raw)) return null
  const name = path.replace(/^\/+/, '') || 'file'

  interface Hunk { start: number; body: string[]; old: number; neu: number }
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  let sawMarker = false

  for (const line of raw.split('\n')) {
    if (PREVIEW_GAP.test(line)) { cur = null; continue }
    const m = PREVIEW_LINE.exec(line)
    if (!m) { cur = null; continue }
    const marker  = m[1]
    const lineNo  = parseInt(m[2], 10)
    const content = m[3]
    if (marker === '+' || marker === '-') sawMarker = true
    if (!cur) {
      cur = { start: lineNo, body: [], old: 0, neu: 0 }
      hunks.push(cur)
    }
    cur.body.push(marker === ' ' ? ` ${content}` : `${marker}${content}`)
    if (marker === ' ' || marker === '-') cur.old++
    if (marker === ' ' || marker === '+') cur.neu++
  }

  // No actual additions/removals means this wasn't a real diff preview.
  if (!sawMarker || hunks.length === 0) return null

  const out: string[] = [
    `diff --git a/${name} b/${name}`,
    'index 1111111..2222222 100644',
    `--- a/${name}`,
    `+++ b/${name}`,
  ]
  for (const h of hunks) {
    out.push(`@@ -${h.start},${h.old} +${h.start},${h.neu} @@`)
    out.push(...h.body)
  }
  return `${out.join('\n')}\n`
}

function patchFromProviderChange(path: string, kindType: string, diff: string): string {
  const name = path.replace(/^\/+/, '') || 'file'
  if (kindType === 'delete') return buildUnifiedDiff(name, diff ?? '', '')
  if (kindType === 'add' || kindType === 'create') return buildUnifiedDiff(name, '', diff ?? '')
  // Modify-in-place. Prefer a real unified diff; otherwise try to convert pi's
  // line-numbered preview format. Anything else is dropped so we never render a
  // synthetic header over un-parseable content.
  if (looksLikeUnifiedDiff(diff)) return normalizePatchForPierre(name, diff)
  return parsePreviewDiff(name, diff) ?? ''
}

// Nested containers providers wrap their tool payload in. We descend these so a
// diff at `result.details.diff` is found, not just a top-level `result.diff`.
const NESTED_PAYLOAD_KEYS = ['details', 'result', 'output', 'data', 'state']

/**
 * Pull precomputed patch payloads out of provider args/results, descending into
 * common nested containers (`details`, `result`, ...). This is a fallback for
 * providers that only emit a tool part after the write finished, so before/after
 * snapshots cannot be captured in time. Only real unified diffs are returned;
 * preview-format strings are rejected so the caller can fall back to git.
 */
export function extractProviderPatchChanges(...payloads: unknown[]): ProviderPatchChange[] {
  const out: ProviderPatchChange[] = []
  // The path and the diff can live in different payloads: pi puts the path in
  // `args.path` but the diff in `result.details.diff`. When a diff is found
  // with no local/inherited path, fall back to any path seen across payloads.
  const fallbackPath = collectTouchedPaths(...payloads)[0] ?? null
  const add = (path: string | null, kindType: string, diff: string | undefined): void => {
    const p = path ?? fallbackPath
    if (!p || !diff) return
    const patch = patchFromProviderChange(p, kindType, diff)
    if (!patch) return
    const existing = out.findIndex(c => c.path === p)
    if (existing === -1) out.push({ path: p, patch })
    else out[existing] = { path: p, patch }
  }

  // Each queue item carries the nearest ancestor path so a diff nested under
  // `details` inherits the `path` declared on its parent result object.
  const queue: { node: unknown; inherited: string | null }[] = payloads.map(node => ({ node, inherited: null }))
  const seen = new Set<Record<string, unknown>>()
  while (queue.length > 0) {
    const { node, inherited } = queue.shift()!
    const src = asRecord(node)
    if (!src || seen.has(src)) continue
    seen.add(src)
    const localPath = pathField(src) ?? inherited
    if (Array.isArray(src.changes)) {
      for (const change of src.changes) {
        const c = asRecord(change)
        if (!c) continue
        const kind = asRecord(c.kind)
        add(pathField(c) ?? localPath, String(kind?.type ?? c.type ?? 'modify'), asString(c.diff) ?? asString(c.patch))
      }
    }
    add(localPath, String(asRecord(src.kind)?.type ?? src.type ?? 'modify'), asString(src.diff) ?? asString(src.patch))
    for (const key of NESTED_PAYLOAD_KEYS) {
      if (src[key] && typeof src[key] === 'object') queue.push({ node: src[key], inherited: localPath })
    }
  }
  return out
}

/**
 * True when a tool *result* carries any diff/patch signal, even one we can't
 * parse (e.g. a preview-format `details.diff`). Used to gate the scoped git
 * fallback so we only run `git diff` for tool calls that plausibly wrote a file.
 */
export function resultHasPatchSignal(...payloads: unknown[]): boolean {
  const queue: unknown[] = [...payloads]
  const seen = new Set<Record<string, unknown>>()
  while (queue.length > 0) {
    const src = asRecord(queue.shift())
    if (!src || seen.has(src)) continue
    seen.add(src)
    if (asString(src.diff) || asString(src.patch) || Array.isArray(src.changes)) return true
    for (const key of NESTED_PAYLOAD_KEYS) {
      if (src[key] && typeof src[key] === 'object') queue.push(src[key])
    }
  }
  return false
}

/**
 * Best-effort collection of every file path a tool call may have touched,
 * pulled from both args and result payloads (descending into nested
 * containers). Feeds the scoped git fallback so it diffs only the files this
 * tool plausibly wrote, never the whole working tree.
 */
export function collectTouchedPaths(...payloads: unknown[]): string[] {
  const paths: string[] = []
  const add = (p: string | null): void => {
    if (p && !paths.includes(p)) paths.push(p)
  }
  const queue: unknown[] = [...payloads]
  const seen = new Set<Record<string, unknown>>()
  while (queue.length > 0) {
    const src = asRecord(queue.shift())
    if (!src || seen.has(src)) continue
    seen.add(src)
    add(pathField(src))
    if (Array.isArray(src.changes)) {
      for (const change of src.changes) {
        const c = asRecord(change)
        if (c) add(pathField(c))
      }
    }
    for (const key of NESTED_PAYLOAD_KEYS) {
      if (src[key] && typeof src[key] === 'object') queue.push(src[key])
    }
  }
  return paths
}
