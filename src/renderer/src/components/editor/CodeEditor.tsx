import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { confirmDialog, promptDialog } from '../../stores/dialog-service'
import { FileTree } from './FileTree'
import { PierreDiff } from '../diff/PierreDiff'
import { Splitter } from '../chat/Splitter'
import { ChatContextMenu, type ChatContextMenuItem } from '../chat/ChatContextMenu'
import { CrewCodeMirrorEditor, type CrewCodeMirrorHandle } from './CrewCodeMirrorEditor'
import { BeardedFileIcon } from './bearded-file-icons'
import type { EditorOutlineSymbol } from './editor-outline'
import { applyLspTextEdits, type EditorCodeAction, type LspRange } from './editor-lsp-features'
import { languageServerFileUri, languageServerRelativePath, useTypeScriptLanguageServer } from './useTypeScriptLanguageServer'
import type { CodeFile } from '../../hooks/useEditorSessions'
import type { RegisteredPluginEditorAction } from '../../../../shared/plugin-types'
import type { CompletionProviderId } from '../../../../shared/agent-completion-types'
import type { EditorThemeId } from '../../../../shared/editor-theme-types'
import { useMobileLayout } from '../../hooks/useMobileLayout'

export type { CodeFile }

interface CodeEditorProps {
  root?: string
  tabs: CodeFile[]
  activeRel: string | null
  cursorMap: Record<string, { start: number; end: number }>
  scrollMap: Record<string, { top: number; left: number }>
  onOpenFile?: (rel: string) => Promise<void>
  onCloseFile?: (rel: string) => void
  onSetActiveRel?: (rel: string | null) => void
  onUpdateText?: (rel: string, text: string) => void
  onSaveFile?: (rel: string) => Promise<void>
  onFormatFile?: (rel: string, text: string) => Promise<string | undefined>
  onSetCursor?: (rel: string, cursor: { start: number; end: number }) => void
  onSetScroll?: (rel: string, scroll: { top: number; left: number }) => void
  onReloadFromDisk?: (rel: string, text: string, size: number) => void
  onNewUntitled?: () => void
  externalDiff?: { title: string; diff: string } | null
  onCloseExternalDiff?: () => void
  gitOpen?: boolean
  onToggleGit?: () => void
  expandedDirs?: string[]
  onExpandedDirsChange?: (rels: string[]) => void
  pluginEditorActions?: RegisteredPluginEditorAction[]
  onPluginEditorAction?: (action: RegisteredPluginEditorAction, rel: string | null) => void
  completion?: { enabled: boolean; provider: CompletionProviderId; model: string }
  theme?: EditorThemeId
}

// ─── Syntax highlighter ───────────────────────────────────────────────────────

const JS_KW = new Set([
  'const','let','var','function','return','if','else','for','while','do',
  'switch','case','break','continue','class','extends','import','export',
  'from','default','new','this','typeof','instanceof','in','of','try','catch',
  'finally','throw','async','await','yield','null','undefined','true','false',
  'void','delete','static','get','set','interface','type','enum','namespace',
  'declare','readonly','abstract','implements','as','keyof','infer','super',
  'protected','private','public','override','satisfies',
])

const HL_LANGS = new Set([
  'ts','tsx','js','jsx','mjs','cjs','mts','cts',
  'css','scss','less','json','jsonc',
  'html','xml','svg',
  'py','rb','go','rs','java','c','cpp','cs','php','swift','kt',
  'sh','bash','zsh',
])

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightLine(line: string, lang: string, inBlock: boolean): { html: string; nextBlock: boolean } {
  if (!HL_LANGS.has(lang)) return { html: escHtml(line), nextBlock: false }

  let out = '', i = 0
  const n = line.length
  let block = inBlock

  if (block) {
    const end = line.indexOf('*/', i)
    if (end === -1) return { html: `<span class="cm">${escHtml(line)}</span>`, nextBlock: true }
    out += `<span class="cm">${escHtml(line.slice(0, end + 2))}</span>`
    i = end + 2; block = false
  }

  while (i < n) {
    const ch = line[i], ch2 = line[i + 1]

    if (ch === '/' && ch2 === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) { out += `<span class="cm">${escHtml(line.slice(i))}</span>`; return { html: out, nextBlock: true } }
      out += `<span class="cm">${escHtml(line.slice(i, end + 2))}</span>`; i = end + 2; continue
    }
    if ((ch === '/' && ch2 === '/') || (ch === '#' && lang !== 'html' && lang !== 'xml')) {
      out += `<span class="cm">${escHtml(line.slice(i))}</span>`; break
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n && line[j] !== ch) { if (line[j] === '\\') j++; j++ }
      if (j < n) j++
      out += `<span class="str">${escHtml(line.slice(i, j))}</span>`; i = j; continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i
      while (j < n && /[0-9a-fA-Fox._]/.test(line[j])) j++
      out += `<span class="num">${escHtml(line.slice(i, j))}</span>`; i = j; continue
    }
    if ((lang === 'html' || lang === 'xml' || lang === 'svg') && ch === '<') {
      let j = line.indexOf('>', i); if (j === -1) j = n - 1
      out += `<span class="tag">${escHtml(line.slice(i, j + 1))}</span>`; i = j + 1; continue
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i
      while (j < n && /[a-zA-Z0-9_$]/.test(line[j])) j++
      const word = line.slice(i, j)
      if (JS_KW.has(word))   out += `<span class="kw">${escHtml(word)}</span>`
      else if (line[j] === '(') out += `<span class="fn">${escHtml(word)}</span>`
      else out += escHtml(word)
      i = j; continue
    }
    out += escHtml(ch); i++
  }
  return { html: out, nextBlock: block }
}

function langFromName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? 'text' : name.slice(dot + 1).toLowerCase()
}

function isTypeScriptLanguage(lang: string): boolean {
  return ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].includes(lang)
}

// ─── Markdown highlighter ──────────────────────────────────────────────────────

const MD_LANGS = new Set(['md', 'markdown', 'mdx', 'mdown', 'mkd', 'mkdn', 'mdwn'])

/** Parse a `[text](url)` (or image) link starting at `start` (the `[`). */
function mdLink(s: string, start: number): { text: string; url: string; end: number } | null {
  if (s[start] !== '[') return null
  const close = s.indexOf(']', start + 1)
  if (close === -1 || s[close + 1] !== '(') return null
  const paren = s.indexOf(')', close + 2)
  if (paren === -1) return null
  return { text: s.slice(start + 1, close), url: s.slice(close + 2, paren), end: paren + 1 }
}

/** Highlight inline markdown spans (code, bold, italic, links). */
function mdInline(s: string): string {
  let out = '', i = 0
  const n = s.length
  while (i < n) {
    const ch = s[i]
    if (ch === '`') {
      const end = s.indexOf('`', i + 1)
      if (end !== -1) { out += `<span class="md-code">${escHtml(s.slice(i, end + 1))}</span>`; i = end + 1; continue }
    }
    if ((ch === '!' && s[i + 1] === '[') || ch === '[') {
      const linkStart = ch === '!' ? i + 1 : i
      const m = mdLink(s, linkStart)
      if (m) {
        const label = escHtml(s.slice(i, m.end - (`(${m.url})`).length))
        out += `<span class="md-link-text">${label}</span>(<span class="md-link">${escHtml(m.url)}</span>)`
        i = m.end; continue
      }
    }
    if ((ch === '*' && s[i + 1] === '*') || (ch === '_' && s[i + 1] === '_')) {
      const marker = ch + ch
      const end = s.indexOf(marker, i + 2)
      if (end !== -1) { out += `<span class="md-bold">${escHtml(s.slice(i, end + 2))}</span>`; i = end + 2; continue }
    }
    if (ch === '*' || ch === '_') {
      const end = s.indexOf(ch, i + 1)
      if (end > i + 1) { out += `<span class="md-italic">${escHtml(s.slice(i, end + 1))}</span>`; i = end + 1; continue }
    }
    out += escHtml(ch); i++
  }
  return out
}

function highlightMarkdownLine(line: string, inFence: boolean): { html: string; nextFence: boolean } {
  const fence = /^\s{0,3}(```|~~~)/.test(line)
  if (inFence) {
    // Stay in the fenced code block; a fence line closes it but still renders as code.
    return { html: `<span class="md-code">${escHtml(line)}</span>`, nextFence: !fence }
  }
  if (fence) return { html: `<span class="md-code">${escHtml(line)}</span>`, nextFence: true }
  if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return { html: `<span class="md-h">${escHtml(line)}</span>`, nextFence: false }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return { html: `<span class="md-hr">${escHtml(line)}</span>`, nextFence: false }
  const bq = /^(\s*>+\s?)/.exec(line)
  if (bq) return { html: `<span class="md-quote">${escHtml(bq[1])}</span>${mdInline(line.slice(bq[1].length))}`, nextFence: false }
  const li = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line)
  if (li) return { html: `<span class="md-list">${escHtml(li[0])}</span>${mdInline(line.slice(li[0].length))}`, nextFence: false }
  return { html: mdInline(line), nextFence: false }
}

type EditorCursor = { start: number; end: number }
type EditorSnapshot = { text: string; cursor: EditorCursor }
type EditorHistoryState = {
  undo: EditorSnapshot[]
  redo: EditorSnapshot[]
  lastGroup: string | null
  lastCursor: EditorCursor | null
  lastAt: number
}

const HISTORY_LIMIT = 80
const HISTORY_TEXT_LIMIT = 250_000
const HISTORY_GROUP_MS = 750

// ─── Diff view ────────────────────────────────────────────────────────────────

function DiffView({ title, diff, onClose }: { title: string; diff: string; onClose: () => void }) {
  return (
    <div className="ed-diff-wrap">
      <div className="ed-diff-bar">
        <button className="ed-diff-close" onClick={onClose}>← back</button>
        <span className="ed-diff-title">{title}</span>
      </div>
      <PierreDiff patch={diff} className="ed-diff-body" />
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CodeEditor({
  root,
  tabs = [],
  activeRel = null,
  cursorMap = {},
  scrollMap = {},
  onOpenFile,
  onCloseFile,
  onSetActiveRel,
  onUpdateText,
  onSaveFile,
  onFormatFile,
  onSetCursor,
  onSetScroll,
  onReloadFromDisk,
  onNewUntitled,
  externalDiff,
  onCloseExternalDiff,
  gitOpen,
  onToggleGit,
  expandedDirs,
  onExpandedDirsChange,
  pluginEditorActions = [],
  onPluginEditorAction,
  completion,
  theme = 'crewcode',
}: CodeEditorProps) {
  const { isMobile } = useMobileLayout()
  const [err,       setErr]       = useState<string | null>(null)
  const [busy,      setBusy]      = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [diffView,   setDiffView]   = useState<{ title: string; diff: string } | null>(null)
  const [ftWidth,    setFtWidth]    = useState(220)
  // Phones start with the code canvas unobstructed. The file tree remains one
  // tap away as an off-canvas panel; desktop retains its persistent default.
  const [ftOpen,     setFtOpen]     = useState(() => !isMobile)
  const [formatting, setFormatting] = useState(false)
  const [fmtNotice,  setFmtNotice]  = useState<string | null>(null)
  const [editorCtx,  setEditorCtx]  = useState<{ x: number; y: number; start: number; end: number } | null>(null)
  const [jumpTrigger, setJumpTrigger] = useState(0)
  const [searchMatch, setSearchMatch] = useState<{ term: string; caseSensitive: boolean } | null>(null)
  const [ghostText, setGhostText] = useState<string | null>(null)
  const [completionStatus, setCompletionStatus] = useState<string | null>(null)
  const [completionEdit, setCompletionEdit] = useState<{ rel: string; revision: number } | null>(null)
  const [outlineSymbols, setOutlineSymbols] = useState<EditorOutlineSymbol[]>([])
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [codeActions, setCodeActions] = useState<EditorCodeAction[] | null>(null)
  const [codeActionNotice, setCodeActionNotice] = useState<string | null>(null)
  const [codeActionContext, setCodeActionContext] = useState<{ uri: string; text: string } | null>(null)
  const [referenceResults, setReferenceResults] = useState<Array<{ uri: string; line: number; column: number }>>([])
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [renamePreview, setRenamePreview] = useState<{ title: string; files: Array<{ rel: string; original: string; next: string; edits: number }> } | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  // Files that changed on disk while the buffer had unsaved edits — we surface a
  // reload affordance instead of silently clobbering the user's work.
  const [diskConflicts, setDiskConflicts] = useState<Set<string>>(() => new Set())

  const editorRef   = useRef<CrewCodeMirrorHandle>(null)
  const historyRef  = useRef<Record<string, EditorHistoryState>>({})
  const beforeInputRef = useRef<{ rel: string; cursor: EditorCursor; inputType: string } | null>(null)
  const pendingJumpRef = useRef<{ rel: string; line: number; column?: number; term?: string; caseSensitive?: boolean } | null>(null)
  const codeActionRequestRef = useRef(0)

  const active = tabs.find(t => t.rel === activeRel) ?? null
  const dirty  = active ? active.text !== active.originalText : false
  const text   = active?.text ?? ''
  const activeLang = active ? langFromName(active.name) : 'text'
  const hasTypeScriptTab = tabs.some(tab => isTypeScriptLanguage(langFromName(tab.name)))
  const languageServer = useTypeScriptLanguageServer(hasTypeScriptTab ? root : undefined)

  const onFtDrag = useCallback((delta: number) => {
    setFtWidth(w => Math.max(140, Math.min(500, w - delta)))
  }, [])
  const onProblemsDrag = useCallback((delta: number) => {
    setFtWidth(w => Math.max(180, Math.min(500, w + delta)))
  }, [])

  const handleDiff = useCallback((title: string, diff: string) => {
    setDiffView({ title, diff })
  }, [])

  const reloadReplacedFiles = useCallback(async (rels: string[]) => {
    if (!root || !onReloadFromDisk) return
    for (const rel of rels) {
      if (!tabs.some(tab => tab.rel === rel)) continue
      const result = await window.electronAPI?.fsReadFile(root, rel)
      if (result?.ok && typeof result.text === 'string') onReloadFromDisk(rel, result.text, result.size ?? result.text.length)
    }
  }, [root, tabs, onReloadFromDisk])

  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile

  // Live disk-reload handlers need the latest tabs/callback without re-subscribing.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const onReloadFromDiskRef = useRef(onReloadFromDisk)
  onReloadFromDiskRef.current = onReloadFromDisk

  const clearConflict = useCallback((rel: string) => {
    setDiskConflicts(prev => {
      if (!prev.has(rel)) return prev
      const next = new Set(prev)
      next.delete(rel)
      return next
    })
  }, [])

  const open = async (rel: string) => {
    if (tabs.some(t => t.rel === rel)) {
      onSetActiveRel?.(rel)
      setDiffView(null)
      onCloseExternalDiff?.()
      return
    }
    if (!onOpenFile) return
    setBusy(true); setErr(null); setDiffView(null); onCloseExternalDiff?.()
    try {
      await onOpenFile(rel)
    } catch (e: any) {
      setErr(e?.message ?? 'failed')
    }
    setBusy(false)
  }

  const handleSelectLine = useCallback((rel: string, line: number, term: string, caseSensitive: boolean) => {
    pendingJumpRef.current = { rel, line, term, caseSensitive }
    setSearchMatch({ term, caseSensitive })
    if (tabs.some(t => t.rel === rel)) {
      onSetActiveRel?.(rel)
      setDiffView(null)
      onCloseExternalDiff?.()
    } else {
      open(rel)
    }
    setJumpTrigger(n => n + 1)
  }, [tabs, onSetActiveRel, onCloseExternalDiff])

  // Rehydrate persisted tabs that haven't been read from disk yet.
  useEffect(() => {
    if (!activeRel || !onOpenFileRef.current) return
    const tab = tabs.find(t => t.rel === activeRel)
    if (!tab || !tab.needsLoad) return
    setBusy(true); setErr(null)
    onOpenFileRef.current(activeRel)
      .catch((e: any) => setErr(e?.message ?? 'failed'))
      .finally(() => setBusy(false))
  }, [activeRel, tabs])

  // Tell the main process which local files to watch for on-disk changes.
  // Untitled buffers and remote (ssh://) roots have no watchable path.
  const watchRels = tabs
    .filter(t => !t.needsLoad && t.rel !== 'untitled' && !t.rel.startsWith('untitled-'))
    .map(t => t.rel)
  const watchKey = Array.from(new Set(watchRels)).sort().join('\n')
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.editorWatchAdd || !api.editorWatchRemove || !root || root.includes('://')) return
    const rels = watchKey ? watchKey.split('\n') : []
    rels.forEach(rel => api.editorWatchAdd(root, rel))
    return () => rels.forEach(rel => api.editorWatchRemove(root, rel))
    // watchKey is the stable content key for the open-file set under `root`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, watchKey])

  // Re-read open files when they change on disk (e.g. an agent rewrites them).
  // Clean buffers reload silently; dirty buffers get a conflict prompt.
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onEditorFileChanged || !root) return
    return api.onEditorFileChanged(async ({ root: changedRoot, rel }) => {
      if (changedRoot !== root) return
      const tab = tabsRef.current.find(t => t.rel === rel)
      if (!tab || tab.needsLoad) return
      const res = await api.fsReadFile(root, rel)
      if (res.error || !res.ok) return
      const nextText = res.text ?? ''
      if (nextText === tab.text) { clearConflict(rel); return }   // already in sync (e.g. our own save)
      if (tab.text !== tab.originalText) {
        setDiskConflicts(prev => { const next = new Set(prev); next.add(rel); return next })
        return
      }
      onReloadFromDiskRef.current?.(rel, nextText, res.size ?? new Blob([nextText]).size)
    })
  }, [root, clearConflict])

  // Completion requests are disposable and never share chat history. Cancelling
  // on every edit prevents a slow model response from landing at a stale cursor.
  useEffect(() => {
    setGhostText(null)
    setCompletionStatus(null)
    if (!completion?.enabled || !active || !activeRel || !root || completionEdit?.rel !== activeRel) return
    const cursor = editorRef.current?.getCursor()
    if (!cursor || cursor.start !== cursor.end || cursor.start < 3) return
    // Inline completion favors a nearby continuation over whole-file analysis.
    // Smaller request bodies reduce hosted-provider time-to-first-suggestion.
    const prefix = text.slice(Math.max(0, cursor.start - 3_500), cursor.start)
    if (prefix.trim().length < 3) return
    const suffix = text.slice(cursor.start, cursor.start + 1_000)
    const requestId = `${activeRel}:${cursor.start}:${Date.now().toString(36)}`
    let cancelled = false
    const timer = window.setTimeout(() => {
      setCompletionStatus(`completing with ${completion.provider}…`)
      window.electronAPI?.agentCompletion({
        requestId,
        provider: completion.provider,
        model: completion.model || undefined,
        cwd: root,
        rel: activeRel,
        language: langFromName(active.name),
        prefix,
        suffix,
      }).then(result => {
        if (cancelled) return
        if (result.ok && result.completion) {
          setGhostText(result.completion)
          setCompletionStatus(null)
        } else {
          setCompletionStatus(`completion: ${result.error ?? 'no suggestion returned'}`)
        }
      }).catch(() => {
        if (!cancelled) setCompletionStatus('completion: request failed')
      })
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.electronAPI?.agentCompletionCancel(requestId)
    }
  }, [completion?.enabled, completion?.provider, completion?.model, active, activeRel, root, completionEdit])

  const reloadConflict = useCallback(async (rel: string) => {
    const api = window.electronAPI
    if (!api || !root) return
    const res = await api.fsReadFile(root, rel)
    if (res.error || !res.ok) return
    const nextText = res.text ?? ''
    onReloadFromDiskRef.current?.(rel, nextText, res.size ?? new Blob([nextText]).size)
    clearConflict(rel)
  }, [root, clearConflict])

  useEffect(() => {
    setOutlineSymbols([])
  }, [activeRel])

  // Restore cursor and scroll position when switching to a file
  useEffect(() => {
    if (!activeRel) return
    const editor = editorRef.current
    if (!editor) return
    const c = cursorMap[activeRel]
    const s = scrollMap[activeRel]
    requestAnimationFrame(() => {
      if (c) editor.setSelection(c.start, c.end)
      if (s) editor.setScroll(s)
      else editor.setScroll({ top: 0, left: 0 })
      editor.focus()
    })
  }, [activeRel])

  // Jump to a specific line when triggered from search results
  useEffect(() => {
    if (!pendingJumpRef.current || activeRel !== pendingJumpRef.current.rel) return
    const editor = editorRef.current
    if (!editor) return
    const tab = tabs.find(t => t.rel === activeRel)
    if (tab?.needsLoad) return
    const { line, column = 0, term, caseSensitive = false } = pendingJumpRef.current
    pendingJumpRef.current = null
    requestAnimationFrame(() => {
      const lineCursor = editor.scrollToLine(line)
      let pos = Math.min(lineCursor.start + column, text.length)
      if (term) {
        const lineText = text.split('\n')[Math.max(0, line - 1)] ?? ''
        const matchColumn = (caseSensitive ? lineText : lineText.toLowerCase()).indexOf(caseSensitive ? term : term.toLowerCase())
        if (matchColumn >= 0) {
          pos = Math.min(lineCursor.start + matchColumn, text.length)
          editor.setSelection(pos, Math.min(pos + term.length, text.length))
        }
      } else if (column > 0) editor.setSelection(pos, pos)
      if (onSetScroll) onSetScroll(activeRel, editor.getScroll())
      if (onSetCursor) onSetCursor(activeRel, { start: pos, end: term ? Math.min(pos + term.length, text.length) : pos })
    })
  }, [jumpTrigger, activeRel, text, tabs, onSetScroll, onSetCursor])

  const handleDefinition = useCallback((uri: string, line: number, column: number) => {
    if (!languageServer.rootUri) return
    const rel = languageServerRelativePath(languageServer.rootUri, uri)
    if (!rel) {
      setCompletionStatus('definition is outside this workspace')
      return
    }
    pendingJumpRef.current = { rel, line, column }
    if (tabs.some(tab => tab.rel === rel)) onSetActiveRel?.(rel)
    else void open(rel)
    setJumpTrigger(value => value + 1)
  }, [languageServer.rootUri, tabs, onSetActiveRel])

  const openProblem = useCallback((uri: string, line: number, column: number) => {
    handleDefinition(uri, line, column)
  }, [handleDefinition])

  const requestCodeActions = useCallback((range: LspRange) => {
    if (!active || !languageServer.client || !languageServer.rootUri) return
    const uri = languageServerFileUri(languageServer.rootUri, active.rel)
    const diagnostics = languageServer.problems
      .filter(problem => problem.uri === uri && problem.range.end.line >= range.start.line && problem.range.start.line <= range.end.line)
      .map(problem => ({ range: problem.range, severity: problem.severity, message: problem.message, source: problem.source, code: problem.code }))
    languageServer.client.sync()
    const requestId = ++codeActionRequestRef.current
    setCodeActionContext({ uri, text: active.text })
    setCodeActionNotice('loading code actions…')
    void languageServer.client.request<
      { textDocument: { uri: string }; range: LspRange; context: { diagnostics: typeof diagnostics } },
      EditorCodeAction[] | null
    >('textDocument/codeAction', { textDocument: { uri }, range, context: { diagnostics } }).then(actions => {
      if (requestId !== codeActionRequestRef.current) return
      setCodeActions(actions?.slice(0, 50) ?? [])
      setCodeActionNotice(actions?.length ? null : 'no code actions available')
    }).catch(error => {
      if (requestId !== codeActionRequestRef.current) return
      setCodeActions([])
      setCodeActionNotice(error instanceof Error ? error.message : 'code actions failed')
    })
  }, [active, languageServer.client, languageServer.rootUri, languageServer.problems])

  const findReferences = useCallback((position: { line: number; character: number }) => {
    if (!active || !languageServer.client || !languageServer.rootUri) return
    const uri = languageServerFileUri(languageServer.rootUri, active.rel)
    languageServer.client.sync()
    void languageServer.client.request<
      { textDocument: { uri: string }; position: typeof position; context: { includeDeclaration: boolean } },
      Array<{ uri: string; range: { start: { line: number; character: number } } }> | null
    >('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: true } }).then(results => {
      setReferenceResults((results ?? []).slice(0, 2_000).map(result => ({ uri: result.uri, line: result.range.start.line, column: result.range.start.character })))
      setReferenceOpen(true)
      setProblemsOpen(false)
    }).catch(error => setCompletionStatus(error instanceof Error ? error.message : 'find references failed'))
  }, [active, languageServer.client, languageServer.rootUri])

  const renameSymbol = useCallback(async (position: { line: number; character: number }) => {
    if (!active || !languageServer.client || !languageServer.rootUri || !root) return
    const newName = (await promptDialog({ title: 'Rename symbol', placeholder: 'new name', confirmText: 'Rename' }))?.trim()
    if (!newName) return
    const uri = languageServerFileUri(languageServer.rootUri, active.rel)
    const startText = active.text
    languageServer.client.sync()
    setRenameBusy(true)
    void languageServer.client.request<
      { textDocument: { uri: string }; position: typeof position; newName: string },
      { changes?: Record<string, import('./editor-lsp-features').LspTextEdit[]>; documentChanges?: unknown[] } | null
    >('textDocument/rename', { textDocument: { uri }, position, newName }).then(async edit => {
      if (!edit || edit.documentChanges || !edit.changes) throw new Error('rename requires unsupported document operations')
      if (tabsRef.current.find(tab => tab.rel === active.rel)?.text !== startText) throw new Error('document changed; request rename again')
      const files: Array<{ rel: string; original: string; next: string; edits: number }> = []
      for (const [changedUri, edits] of Object.entries(edit.changes)) {
        const rel = languageServerRelativePath(languageServer.rootUri!, changedUri)
        if (!rel) throw new Error('rename targets a file outside this workspace')
        const openTab = tabs.find(tab => tab.rel === rel)
        const result = openTab ? { ok: true, text: openTab.text } : await window.electronAPI?.fsReadFile(root, rel)
        if (!result?.ok || typeof result.text !== 'string') throw new Error(`failed to read ${rel}`)
        const next = applyLspTextEdits(result.text, edits)
        if (next == null) throw new Error(`invalid or overlapping edits for ${rel}`)
        files.push({ rel, original: result.text, next, edits: edits.length })
      }
      setRenamePreview({ title: `Rename to ${newName}`, files })
      setReferenceOpen(true)
      setProblemsOpen(false)
    }).catch(error => setCompletionStatus(error instanceof Error ? error.message : 'rename failed')).finally(() => setRenameBusy(false))
  }, [active, languageServer.client, languageServer.rootUri, root, tabs])

  const applyRename = useCallback(async () => {
    if (!renamePreview || !root || renameBusy) return
    const dirty = renamePreview.files.filter(file => tabs.some(tab => tab.rel === file.rel && tab.text !== tab.originalText))
    if (dirty.length) { setCompletionStatus(`save affected files first: ${dirty.map(file => file.rel).join(', ')}`); return }
    setRenameBusy(true)
    const written: typeof renamePreview.files = []
    try {
      for (const file of renamePreview.files) {
        const current = await window.electronAPI?.fsReadFile(root, file.rel)
        if (!current?.ok || current.text !== file.original) throw new Error(`${file.rel} changed since preview`)
        const result = await window.electronAPI?.fsWriteFile(root, file.rel, file.next)
        if (!result?.ok) throw new Error(result?.error ?? `failed to write ${file.rel}`)
        written.push(file)
      }
      await reloadReplacedFiles(written.map(file => file.rel))
      setRenamePreview(null)
      setReferenceOpen(false)
    } catch (error) {
      for (const file of [...written].reverse()) await window.electronAPI?.fsWriteFile(root, file.rel, file.original)
      setCompletionStatus(error instanceof Error ? error.message : 'rename failed')
    } finally { setRenameBusy(false) }
  }, [renamePreview, root, renameBusy, tabs, reloadReplacedFiles])

  const applyCodeAction = useCallback((action: EditorCodeAction) => {
    if (!active || !languageServer.rootUri || !onUpdateText) return
    const uri = languageServerFileUri(languageServer.rootUri, active.rel)
    const changedUris = Object.keys(action.edit?.changes ?? {})
    if (!codeActionContext || codeActionContext.uri !== uri || codeActionContext.text !== active.text) {
      setCodeActionNotice('the document changed; request code actions again')
      return
    }
    if (action.disabled) { setCodeActionNotice(action.disabled.reason); return }
    if (action.command || changedUris.some(changedUri => changedUri !== uri)) {
      setCodeActionNotice('this action requires an unsupported command or multi-file edit')
      return
    }
    const edits = action.edit?.changes?.[uri]
    if (!edits?.length) { setCodeActionNotice('this action has no applicable text edits'); return }
    const next = applyLspTextEdits(active.text, edits)
    if (next == null) { setCodeActionNotice('the language server returned invalid or overlapping edits'); return }
    onUpdateText(active.rel, next)
    setCodeActions(null)
    setCodeActionContext(null)
    setCodeActionNotice(`applied: ${action.title}`)
  }, [active, languageServer.rootUri, onUpdateText, codeActionContext])

  const selectOutlineSymbol = useCallback((outline: EditorOutlineSymbol) => {
    const editor = editorRef.current
    if (!editor || !activeRel) return
    const lineCursor = editor.scrollToLine(outline.line)
    const pos = Math.min(lineCursor.start + outline.column, text.length)
    editor.setSelection(pos, pos)
    onSetCursor?.(activeRel, { start: pos, end: pos })
    onSetScroll?.(activeRel, editor.getScroll())
  }, [activeRel, text, onSetCursor, onSetScroll])

  const getHistory = (rel: string): EditorHistoryState => {
    return historyRef.current[rel] ??= { undo: [], redo: [], lastGroup: null, lastCursor: null, lastAt: 0 }
  }

  const currentEditorCursor = (): EditorCursor => editorRef.current?.getCursor() ?? { start: 0, end: 0 }

  const snapshotMatches = (a: EditorSnapshot | undefined, b: EditorSnapshot): boolean => (
    !!a && a.text === b.text && a.cursor.start === b.cursor.start && a.cursor.end === b.cursor.end
  )

  const recordHistory = (rel: string, snapshot: EditorSnapshot, group: string | null, nextCursor?: EditorCursor) => {
    const state = getHistory(rel)
    const now = Date.now()
    if (snapshot.text.length > HISTORY_TEXT_LIMIT) {
      state.redo = []
      state.lastGroup = null
      state.lastCursor = null
      state.lastAt = now
      return
    }

    const cursorContinues = !state.lastCursor || (state.lastCursor.start === snapshot.cursor.start && state.lastCursor.end === snapshot.cursor.end)
    const canCoalesce = !!group && state.lastGroup === group && cursorContinues && now - state.lastAt < HISTORY_GROUP_MS
    if (!canCoalesce && !snapshotMatches(state.undo[state.undo.length - 1], snapshot)) {
      // Full snapshots are fastest to apply; bound them so large files don't
      // turn long editing sessions into unbounded memory growth.
      state.undo.push(snapshot)
      if (state.undo.length > HISTORY_LIMIT) state.undo.splice(0, state.undo.length - HISTORY_LIMIT)
    }
    state.redo = []
    state.lastGroup = group
    state.lastCursor = group ? (nextCursor ?? null) : null
    state.lastAt = now
  }

  const restoreEditorSelection = (start: number, end: number) => {
    editorRef.current?.setSelection(start, end)
    if (activeRel && onSetCursor) onSetCursor(activeRel, { start, end })
  }

  const updateActiveText = (
    next: string,
    opts: { beforeCursor?: EditorCursor; afterCursor?: EditorCursor; groupCursor?: EditorCursor; historyGroup?: string | null; trackHistory?: boolean } = {},
  ) => {
    if (!activeRel || !onUpdateText) return
    if (opts.trackHistory !== false && next !== text) {
      recordHistory(activeRel, { text, cursor: opts.beforeCursor ?? currentEditorCursor() }, opts.historyGroup ?? null, opts.groupCursor ?? opts.afterCursor)
    }
    onUpdateText(activeRel, next)
    if (opts.afterCursor) {
      const { start, end } = opts.afterCursor
      requestAnimationFrame(() => {
        restoreEditorSelection(start, end)
      })
    }
  }

  const pushBounded = (stack: EditorSnapshot[], snapshot: EditorSnapshot) => {
    if (snapshot.text.length > HISTORY_TEXT_LIMIT) return
    stack.push(snapshot)
    if (stack.length > HISTORY_LIMIT) stack.splice(0, stack.length - HISTORY_LIMIT)
  }

  const applyHistorySnapshot = (snapshot: EditorSnapshot) => {
    if (!activeRel || !onUpdateText) return
    onUpdateText(activeRel, snapshot.text)
    const start = Math.min(snapshot.cursor.start, snapshot.text.length)
    const end = Math.min(snapshot.cursor.end, snapshot.text.length)
    requestAnimationFrame(() => restoreEditorSelection(start, end))
  }

  const undo = () => { editorRef.current?.undo() }

  const redo = () => { editorRef.current?.redo() }

  const closeTab = async (rel: string) => {
    const t = tabs.find(x => x.rel === rel)
    if (t && t.text !== t.originalText) {
      const ok = await confirmDialog({
        title:       'Discard unsaved changes?',
        body:        `"${t.name}" has unsaved changes that will be lost.`,
        confirmText: 'Discard',
        danger:      true,
      })
      if (!ok) return
    }
    delete historyRef.current[rel]
    onCloseFile?.(rel)
  }

  async function format() {
    if (!root || !active || !onFormatFile || !onUpdateText) return
    setFormatting(true)
    const beforeCursor = currentEditorCursor()
    const next = await onFormatFile(active.rel, active.text)
    setFormatting(false)
    if (next === undefined) { setFmtNotice('format failed'); setTimeout(() => setFmtNotice(null), 3000); return }
    const cursor = Math.min(beforeCursor.start, next.length)
    updateActiveText(next, { beforeCursor, afterCursor: { start: cursor, end: cursor }, historyGroup: 'format' })
    setFmtNotice('formatted'); setTimeout(() => setFmtNotice(null), 2000)
  }

  const saveRef = useRef<() => Promise<void>>()
  const formatRef = useRef<() => Promise<void>>()
  const undoRef = useRef<() => void>()
  const redoRef = useRef<() => void>()
  async function save() {
    if (!active || !dirty || !onSaveFile) return
    setSaving(true); setErr(null)
    try {
      await onSaveFile(active.rel)
    } catch (e: any) {
      setErr(e?.message ?? 'save failed')
    }
    setSaving(false)
  }
  saveRef.current = save
  formatRef.current = format
  undoRef.current = undo
  redoRef.current = redo

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const isMac = navigator.userAgent.includes('Mac')
      const mod = isMac ? e.metaKey : e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 's') { e.preventDefault(); saveRef.current?.() }
      if (mod && e.shiftKey && key === 'f') { e.preventDefault(); formatRef.current?.() }

    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])

  const writeEditorClipboard = async (value: string): Promise<boolean> => {
    // Electron IPC is reliable in packaged file:// builds where browser clipboard
    // permissions can deny textarea context-menu actions.
    try {
      const result = await window.electronAPI?.clipboardWriteText?.(value)
      if (result?.ok) return true
    } catch { /* fall back to browser clipboard */ }
    try {
      if (!navigator.clipboard?.writeText) return false
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      return false
    }
  }

  const readEditorClipboard = async (): Promise<string | null> => {
    try {
      const result = await window.electronAPI?.clipboardReadText?.()
      if (result?.ok) return result.text ?? ''
    } catch { /* fall back to browser clipboard */ }
    try {
      if (navigator.clipboard?.readText) return await navigator.clipboard.readText()
    } catch { /* paste unavailable */ }
    return null
  }

  const openEditorContextMenu = (e: MouseEvent, cursor: EditorCursor) => {
    e.preventDefault()
    editorRef.current?.focus()
    setEditorCtx({ x: e.clientX, y: e.clientY, start: cursor.start, end: cursor.end })
  }

  const handleEditorContextPick = async (id: string) => {
    if (id === 'undo') { undo(); return }
    if (id === 'redo') { redo(); return }

    const menu = editorCtx
    if (!menu) return
    const start = Math.max(0, Math.min(menu.start, menu.end, text.length))
    const end   = Math.max(0, Math.min(Math.max(menu.start, menu.end), text.length))
    restoreEditorSelection(start, end)

    if (id === 'copy' || id === 'cut') {
      if (start === end) return
      const copied = await writeEditorClipboard(text.slice(start, end))
      if (!copied || id === 'copy') return
      const next = text.slice(0, start) + text.slice(end)
      updateActiveText(next, { beforeCursor: { start, end }, afterCursor: { start, end: start } })
      return
    }

    if (id === 'paste') {
      const pasted = await readEditorClipboard()
      if (pasted === null || pasted.length === 0) return
      const next = text.slice(0, start) + pasted + text.slice(end)
      const cursor = start + pasted.length
      updateActiveText(next, { beforeCursor: { start, end }, afterCursor: { start: cursor, end: cursor } })
    }
  }

  if (!root) {
    return (
      <div className="ed-shell">
        <div className="ed-pathbar"><span className="ed-path">no workspace selected</span></div>
      </div>
    )
  }

  const lang  = active ? langFromName(active.name) : 'text'
  const lines = text.split('\n')

  function wrapMatchInHtml(html: string, term: string, caseSensitive: boolean): string {
    if (!term) return html
    const flags = caseSensitive ? 'g' : 'gi'
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(esc, flags)
    // Split into HTML tags and text content so we only replace in text
    const parts = html.split(/(<[^>]+>)/g)
    return parts.map(part => {
      if (part.startsWith('<')) return part
      return part.replace(regex, '<span class="ed-match">$&</span>')
    }).join('')
  }

  const isMarkdown = MD_LANGS.has(lang)
  let hlLines: string[] = []
  if (active) {
    let blockState = false
    for (const line of lines) {
      let html: string
      if (isMarkdown) {
        const r = highlightMarkdownLine(line, blockState)
        html = r.html
        blockState = r.nextFence
      } else {
        const r = highlightLine(line, lang, blockState)
        html = r.html
        blockState = r.nextBlock
      }
      const withMatch = searchMatch ? wrapMatchInHtml(html, searchMatch.term, searchMatch.caseSensitive) : html
      hlLines.push(withMatch)
    }
  }

  const shortcutMod = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+'
  const canUndo = editorRef.current?.canUndo() ?? false
  const canRedo = editorRef.current?.canRedo() ?? false
  const hasCtxSelection = !!editorCtx && editorCtx.start !== editorCtx.end
  const editorContextItems: ChatContextMenuItem[] = [
    { id: 'undo',  label: 'undo',  icon: 'undo', kbd: `${shortcutMod}Z`, disabled: !canUndo },
    { id: 'redo',  label: 'redo',  icon: 'refresh', kbd: navigator.userAgent.includes('Mac') ? '⇧⌘Z' : 'Ctrl+Y', disabled: !canRedo },
    { id: 'sep-history', label: '', divider: true },
    { id: 'cut',   label: 'cut',   icon: 'edit', kbd: `${shortcutMod}X`, disabled: !hasCtxSelection },
    { id: 'copy',  label: 'copy',  icon: 'copy', kbd: `${shortcutMod}C`, disabled: !hasCtxSelection },
    { id: 'paste', label: 'paste', icon: 'edit', kbd: `${shortcutMod}V` },
  ]

  return (
    <div className="ed-shell">
      <div className="ed-pathbar">
        <span className="ed-path">{active ? `${root}/${active.rel}` : root}</span>
        {dirty && <span className="ed-dirty" title="unsaved changes">●</span>}
        {saving && <span className="ed-saving">saving…</span>}
        {fmtNotice && <span className="ed-saving">{fmtNotice}</span>}
        {completionStatus && <span className="ed-saving" title={completionStatus}>{completionStatus}</span>}
        {active && diskConflicts.has(active.rel) && (
          <span className="ed-disk-conflict" title="this file changed on disk while you had unsaved edits">
            changed on disk
            <button type="button" onClick={() => reloadConflict(active.rel)}>reload</button>
            <button type="button" onClick={() => clearConflict(active.rel)}>keep mine</button>
          </span>
        )}
        <div className="ed-pathbar-actions">
          {active && (
            <button
              title={formatting ? 'formatting…' : 'format (Ctrl+Shift+F)'}
              onClick={format}
              disabled={formatting}
            >
              <Icon name="sliders" size={13} />
            </button>
          )}
          {active && dirty && (
            <button title="save (Ctrl+S)" onClick={save}>
              <Icon name="sparkle" size={13} />
            </button>
          )}
          {active && isTypeScriptLanguage(activeLang) && (
            <>
              <button title="find references (Shift+F12)" onClick={() => {
                const cursor = editorRef.current?.getCursor()
                if (!cursor) return
                const before = text.slice(0, cursor.start)
                const line = before.split('\n').length - 1
                const character = cursor.start - (before.lastIndexOf('\n') + 1)
                findReferences({ line, character })
              }}><Icon name="search" size={13} /></button>
              <button title="rename symbol (F2)" onClick={() => {
                const cursor = editorRef.current?.getCursor()
                if (!cursor) return
                const before = text.slice(0, cursor.start)
                const line = before.split('\n').length - 1
                const character = cursor.start - (before.lastIndexOf('\n') + 1)
                renameSymbol({ line, character })
              }}><Icon name="edit" size={13} /></button>
            </>
          )}
          {active && pluginEditorActions.map(action => (
            <button
              key={action.registrationId}
              title={`${action.title} · ${action.pluginId}`}
              onClick={() => onPluginEditorAction?.(action, active.rel)}
            >
              <Icon name="plug" size={13} />
            </button>
          ))}
          <button title="copy path" onClick={() => active && navigator.clipboard.writeText(`${root}/${active.rel}`)}>
            <Icon name="copy" size={13} />
          </button>
          {onToggleGit && (
            <button
              className={`ed-git-toggle ${gitOpen ? 'on' : ''}`}
              title={gitOpen ? 'hide git sidebar' : 'show git sidebar'}
              onClick={onToggleGit}
            >
              <Icon name="gitBranch" size={13} />
            </button>
          )}
            <button
          className={`ed-ft-toggle ${ftOpen ? 'on' : ''}`}
          title={ftOpen ? 'hide file tree' : 'show file tree'}
          onClick={() => setFtOpen(o => !o)}
        >
          <Icon name="listTree" size={13} />
        </button>
        </div>
      </div>

      <div className="ed-main">
        {referenceOpen && (
          <>
            <div className="ed-problems ed-problems-drawer" style={{ width: ftWidth }}>
              <div className="ed-problems-head">
                <strong>{renamePreview?.title ?? 'References'}</strong>
                <span>{renamePreview ? renamePreview.files.reduce((sum, file) => sum + file.edits, 0) : referenceResults.length}</span>
                <button type="button" onClick={() => { setReferenceOpen(false); setRenamePreview(null) }}><Icon name="x" size={11} /></button>
              </div>
              <div className="ed-problems-list">
                {renamePreview ? renamePreview.files.map(file => (
                  <div className="ed-problem" key={file.rel}>
                    <span className="ed-problem-message">{file.rel}</span>
                    <span className="ed-problem-location">{file.edits} edits</span>
                  </div>
                )) : referenceResults.map((reference, index) => {
                  const rel = languageServer.rootUri ? languageServerRelativePath(languageServer.rootUri, reference.uri) : null
                  return rel ? (
                    <button type="button" className="ed-problem" key={`${reference.uri}:${reference.line}:${index}`} onClick={() => openProblem(reference.uri, reference.line + 1, reference.column)}>
                      <span className="ed-problem-dot" />
                      <span className="ed-problem-message">{rel}</span>
                      <span className="ed-problem-location">{reference.line + 1}:{reference.column + 1}</span>
                    </button>
                  ) : null
                })}
              </div>
              {renamePreview && <button type="button" className="ed-change-apply" disabled={renameBusy} onClick={() => void applyRename()}>{renameBusy ? 'Applying…' : 'Apply rename'}</button>}
            </div>
            <Splitter orientation="vertical" onDrag={onProblemsDrag} />
          </>
        )}
        {problemsOpen && !referenceOpen && (
          <>
            <div className="ed-problems ed-problems-drawer" style={{ width: ftWidth }}>
              <div className="ed-problems-head">
                <strong>Problems</strong>
                <span>{languageServer.problems.length}</span>
                <button type="button" onClick={() => setProblemsOpen(false)}><Icon name="x" size={11} /></button>
              </div>
              <div className="ed-problems-list">
                {languageServer.problems.length === 0 && <div className="ed-problems-empty">No problems detected</div>}
                {languageServer.problems.map((problem, index) => {
                  const rel = languageServer.rootUri ? languageServerRelativePath(languageServer.rootUri, problem.uri) : null
                  if (!rel) return null
                  return (
                    <button
                      type="button"
                      className={`ed-problem severity-${problem.severity}`}
                      key={`${problem.uri}:${problem.range.start.line}:${problem.range.start.character}:${index}`}
                      onClick={() => openProblem(problem.uri, problem.range.start.line + 1, problem.range.start.character)}
                    >
                      <span className="ed-problem-dot" />
                      <span className="ed-problem-message">{problem.message}</span>
                      <span className="ed-problem-location">{rel}:{problem.range.start.line + 1}:{problem.range.start.character + 1}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <Splitter orientation="vertical" onDrag={onProblemsDrag} />
          </>
        )}
        <div className="ed-pane">
          {tabs.length > 0 && (
            <div className="ed-tabs" role="tablist">
              {tabs.map(t => {
                const isActive = t.rel === activeRel
                const isDirty  = t.text !== t.originalText
                return (
                  <div
                    key={t.rel}
                    className={`ed-tab ${isActive ? 'active' : ''}`}
                    role="tab"
                    aria-selected={isActive}
                    title={t.rel}
                    onClick={() => { onSetActiveRel?.(t.rel); setDiffView(null); onCloseExternalDiff?.() }}
                    onAuxClick={e => { if (e.button === 1) { e.preventDefault(); closeTab(t.rel) } }}
                  >
                    <BeardedFileIcon name={t.name} size={15} className="ed-tab-file-icon" />
                    <span className="ed-tab-name">{t.name}</span>
                    <span
                      className={`ed-tab-close ${isDirty ? 'dirty' : ''}`}
                      onClick={e => { e.stopPropagation(); closeTab(t.rel) }}
                      title={isDirty ? 'close (unsaved)' : 'close'}
                    >
                      {isDirty ? <span className="ed-tab-dot" /> : <Icon name="x" size={11} />}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="ed-body">
            {!active && !busy && !err && !externalDiff && (
              <div className="ed-empty">
                select a file to edit
                {onNewUntitled && (
                  <button type="button" className="ed-empty-action" onClick={onNewUntitled}>
                    or start an untitled file
                  </button>
                )}
              </div>
            )}
            {busy  && <div className="ed-empty">loading…</div>}
            {err   && <div className="ed-empty" style={{ color: 'var(--err, #e06464)' }}>{err}</div>}

            {externalDiff && (
              <DiffView title={externalDiff.title} diff={externalDiff.diff} onClose={() => onCloseExternalDiff?.()} />
            )}

            {!externalDiff && active && diffView && !busy && (
              <DiffView title={diffView.title} diff={diffView.diff} onClose={() => setDiffView(null)} />
            )}

            {!externalDiff && active && !diffView && !busy && (
              <CrewCodeMirrorEditor
                ref={editorRef}
                rel={active.rel}
                name={active.name}
                text={text}
                cursor={cursorMap[active.rel]}
                scroll={scrollMap[active.rel]}
                searchMatch={searchMatch}
                ghostText={ghostText}
                theme={theme}
                languageServer={languageServer.client && languageServer.rootUri && isTypeScriptLanguage(activeLang) ? {
                  client: languageServer.client,
                  uri: languageServerFileUri(languageServer.rootUri, active.rel),
                  languageId: ['ts', 'tsx', 'mts', 'cts'].includes(activeLang) ? 'typescript' : 'javascript',
                } : null}
                onDefinition={handleDefinition}
                onCodeActions={requestCodeActions}
                onFindReferences={findReferences}
                onRenameSymbol={renameSymbol}
                onOutlineChange={setOutlineSymbols}
                onChange={next => {
                  if (activeRel && onUpdateText) onUpdateText(activeRel, next)
                }}
                onUserInput={() => {
                  if (!activeRel) return
                  setCompletionEdit(previous => ({ rel: activeRel, revision: (previous?.revision ?? 0) + 1 }))
                }}
                onCursorChange={cursor => {
                  if (activeRel && onSetCursor) onSetCursor(activeRel, cursor)
                }}
                onScrollChange={scroll => {
                  if (activeRel && onSetScroll) onSetScroll(activeRel, scroll)
                }}
                onContextMenu={openEditorContextMenu}
              />
            )}
            {(codeActions !== null || codeActionNotice) && (
              <div className="ed-code-actions" role="dialog" aria-label="Code actions">
                <div className="ed-code-actions-head">
                  <span>Code Actions</span>
                  <button type="button" onClick={() => { codeActionRequestRef.current++; setCodeActions(null); setCodeActionNotice(null); setCodeActionContext(null) }}><Icon name="x" size={11} /></button>
                </div>
                {codeActionNotice && <div className="ed-code-action-notice">{codeActionNotice}</div>}
                {codeActions?.map((action, index) => (
                  <button key={`${action.title}:${index}`} type="button" disabled={!!action.disabled} onClick={() => applyCodeAction(action)}>
                    <span>{action.title}</span>
                    {action.kind && <small>{action.kind}</small>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ed-status">
            <span className="ed-status-branch"><Icon name="branch" size={11} />{lang.toUpperCase()}</span>
            <span>UTF-8  LF</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}>
              {hasTypeScriptTab && (
                <button type="button" className="ed-status-problems" onClick={() => setProblemsOpen(open => !open)}>
                  Problems: {languageServer.problems.length}
                </button>
              )}
              {active && isTypeScriptLanguage(activeLang) && (
                <span title={languageServer.error ?? undefined}>
                  TS LSP: {languageServer.status === 'ready' ? 'ready' : languageServer.status}
                </span>
              )}
              {active && <span>{lines.length} lines · {active.size} B</span>}
            </div>
          </div>
        </div>

        {ftOpen && !problemsOpen && !referenceOpen && (
          <>
            {isMobile && <button type="button" className="ed-mobile-tree-backdrop" aria-label="Close file tree" onClick={() => setFtOpen(false)} />}
            {!isMobile && <Splitter orientation="vertical" onDrag={onFtDrag} />}
            <FileTree
              root={root}
              activeRel={active?.rel}
              width={ftWidth}
              onDiff={handleDiff}
              onSelect={(rel) => { void open(rel); if (isMobile) setFtOpen(false) }}
              onSelectLine={handleSelectLine}
              openTabs={tabs.map(t => t.rel)}
              outlineSymbols={outlineSymbols}
              outlineFileName={active?.name}
              onSelectOutline={selectOutlineSymbol}
              dirtyRels={tabs.filter(tab => tab.text !== tab.originalText).map(tab => tab.rel)}
              onReplaceApplied={reloadReplacedFiles}
              expandedDirs={expandedDirs}
              onExpandedDirsChange={onExpandedDirsChange}
            />
          </>
        )}
      </div>

      {editorCtx && (
        <ChatContextMenu
          x={editorCtx.x}
          y={editorCtx.y}
          items={editorContextItems}
          onPick={handleEditorContextPick}
          onClose={() => setEditorCtx(null)}
        />
      )}
    </div>
  )
}
