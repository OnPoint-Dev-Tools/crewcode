import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { createPatch } from 'diff'
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  linkDialogPlugin,
  imagePlugin,
  tablePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  frontmatterPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  CreateLink,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  InsertCodeBlock,
  ListsToggle,
  DiffSourceToggleWrapper,
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'

import { ChatPane } from '../chat/ChatPane'
import type { McpServerConfig } from '../../hooks/useSettings'
import { Splitter } from '../chat/Splitter'
import { FileTree } from '../editor/FileTree'
import { clearMarkdownDraft, loadMarkdownDraft, saveMarkdownDraft } from '../editor/markdown-draft-storage'
import { PierreDiff } from '../diff/PierreDiff'
import { Icon } from '../ui/Icon'
import type { AgentInfo, GitHubStatus, Message, Session, Workspace } from '../../types'
import type { CustomCommand, Prompt, Skill } from '../../types/prompts'
import type { GitAuthCredentials, GitAuthRequest, GitSigningRequest } from '../../hooks/useGitSidebar'
import type { Layout } from '../../hooks/useTerminalSessions'

const WRITER_PROMPT_STORAGE = 'crewcode:writerWorkspace:systemPrompt:v1'

type WriterFormat = 'md' | 'txt' | 'docx' | 'pdf'

const WRITER_FORMATS: Array<{ id: WriterFormat; label: string; ext: string; binary?: boolean; hint: string }> = [
  { id: 'md', label: 'Markdown', ext: 'md', hint: 'Rich text editor with markdown source' },
  { id: 'txt', label: 'Plain text', ext: 'txt', hint: 'Lightweight manuscript text' },
  { id: 'docx', label: 'DOCX', ext: 'docx', binary: true, hint: 'Markdown working copy with DOCX export' },
  { id: 'pdf', label: 'PDF', ext: 'pdf', binary: true, hint: 'Extract text to Markdown; export after review' },
]

interface WriterFormatDropdownProps {
  value: WriterFormat
  onChange: (value: WriterFormat) => void
}

function WriterFormatDropdown({ value, onChange }: WriterFormatDropdownProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const selected = WRITER_FORMATS.find(format => format.id === value) ?? WRITER_FORMATS[0]

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="writer-format-picker" ref={wrapRef}>
      <button
        id="writer-format"
        type="button"
        className={`writer-format-trigger ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(isOpen => !isOpen)}
      >
        <span>
          <strong>{selected.label}</strong>
          <small>.{selected.ext}</small>
        </span>
        <Icon name="chevDown" size={13} />
      </button>
      {open && (
        <div className="writer-format-menu" role="menu" aria-label="new document format">
          {WRITER_FORMATS.map(format => {
            const active = format.id === value
            return (
              <button
                key={format.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`writer-format-option ${active ? 'on' : ''}`}
                onClick={() => {
                  onChange(format.id)
                  setOpen(false)
                }}
              >
                <span className="writer-format-option-main">
                  <span>{format.label}</span>
                  <small>{format.hint}</small>
                </span>
                <span className="writer-format-ext">.{format.ext}</span>
                {active && <Icon name="check" size={13} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const CODE_LANGS = {
  ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', json: 'JSON',
  css: 'CSS', html: 'HTML', md: 'Markdown', py: 'Python', rs: 'Rust', go: 'Go',
  sh: 'Shell', bash: 'Bash', yaml: 'YAML', toml: 'TOML', sql: 'SQL', '': 'Plain text',
}

const DEFAULT_WRITER_PROMPT = `You are a focused writing collaborator for bloggers and authors.
- Work only on content strategy, drafting, editing, structure, tone, and publishing polish.
- Do not perform coding tasks or broad repository changes from this workspace.
- Treat the active document as the source of truth.
- Suggest document edits as complete replacement text or clearly bounded patches for review.
- Never overwrite the user's document without explicit approval through the Writer diff review.`

function readStoredPrompt(): string {
  try { return localStorage.getItem(WRITER_PROMPT_STORAGE) || DEFAULT_WRITER_PROMPT } catch { return DEFAULT_WRITER_PROMPT }
}

function smallHash(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0
  return Math.abs(hash).toString(36)
}

function isWriterFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt') || lower.endsWith('.docx') || lower.endsWith('.pdf')
}

function isRichMarkdown(rel: string | null): boolean {
  const lower = rel?.toLowerCase() ?? ''
  return lower.endsWith('.md') || lower.endsWith('.mdx')
}

function looksRiskyForMdx(text: string): boolean {
  return /<(?![a-zA-Z!\/>])/m.test(text) || /<\/(?![a-zA-Z>])/m.test(text)
}

interface WriterWorkspaceProps {
  tabId: string
  activeWs: string
  workspace: Workspace
  effectivePath: string
  effectiveBranch: string
  worktreeBranch?: string | null
  agents: AgentInfo[]
  chatSessions: any
  workspaceSessions: Session[]
  resolveHandoffSessionPath: (session: Session) => string
  onHandoffDestinationActivate: (session: Session) => void
  bridges: any
  pty: any
  density?: 'compact' | 'regular'
  threadView: 'chat' | 'code' | 'md'
  setThreadView: (view: 'chat' | 'code' | 'md') => void
  shortcutOverrides?: any
  onOpenFile: (path: string) => void
  onOpenPrompts: () => void
  onOpenBrowser?: (url?: string) => void
  prompts?: Prompt[]
  skills?: Skill[]
  commands?: CustomCommand[]
  enabledSkills?: Skill[]
  onToggleSkillEnabled?: (id: string) => void
  settingsDefaultAgent?: string
  settingsDefaultMode?: string
  // Forwarded to the embedded ChatPane via {...props} so the writer chat also
  // gets the composer MCP picker.
  mcpEnabled?: boolean
  mcpServers?: McpServerConfig[]
  gitOpen: boolean
  setGitOpen: (open: boolean) => void
  github?: GitHubStatus | null
  dirtyCount?: number
  currentWorktreeId: string | null
  onSwitchWorktree: (id: string | null) => void
  onGitAskAgent?: (text: string, targetTabId?: string) => void
  onRequestGitAuth?: (request: GitAuthRequest) => Promise<GitAuthCredentials | null>
  onRequestSigningPassphrase?: (request: GitSigningRequest) => Promise<string | null>
  alwaysCommitUnsigned?: boolean
  gitWidth: number
  setGitWidth: React.Dispatch<React.SetStateAction<number>>
  onOpenGitFileDiff: (path: string, staged: boolean) => void
  pendingGitDiff: { title: string; diff: string } | null
  setPendingGitDiff: (d: { title: string; diff: string } | null) => void
  changesDrawerOpen: boolean
  setChangesDrawerOpen: (open: boolean) => void
  onThreadContextMenu?: (e: React.MouseEvent) => void
  terminalColumnVisible?: boolean
  onTerminalColumnVisibleChange?: (visible: boolean) => void
  termWidth?: number
  setTermWidth?: React.Dispatch<React.SetStateAction<number>>
  terminalShell?: string
  termLayout?: Layout
  onTermLayoutChange?: (layout: Layout) => void
  onSessionDrop?: (payload: { sessionId: string; tabId: string }) => void
}

export function WriterWorkspace(props: WriterWorkspaceProps) {
  const [split, setSplit] = useState(42)
  const [activeRel, setActiveRel] = useState<string | null>(null)
  const [systemPrompt, setSystemPrompt] = useState(readStoredPrompt)

  useEffect(() => {
    try { localStorage.setItem(WRITER_PROMPT_STORAGE, systemPrompt) } catch { /* non-fatal */ }
  }, [systemPrompt])

  const writerSkill = useMemo<Skill>(() => ({
    id: `writer-workspace-${smallHash(systemPrompt)}-${activeRel ?? 'none'}`,
    title: 'Writer Workspace guardrails',
    description: 'Focused writing system prompt and document-editing review rules.',
    category: 'docs',
    mode: 'Build',
    agent: 'opencode',
    favorite: false,
    used: 0,
    lastUsed: '',
    createdAt: '',
    updatedAt: '',
    enabled: true,
    body: `${systemPrompt}\n\nActive writer document: ${activeRel ? `@${activeRel}` : '(none selected)'}\nAll document changes must be proposed for the Writer diff review before they are applied.`,
  }), [activeRel, systemPrompt])

  const enabledSkills = useMemo(() => [writerSkill, ...(props.enabledSkills ?? [])], [props.enabledSkills, writerSkill])
  const freshChat = useMemo(() => ({
    kicker: 'writing mode',
    title: `Ready to write in ${props.workspace.name}?`,
    body: 'Draft, revise, outline, or ask for an edit pass on the active document.',
    suggestions: ['Outline this article', 'Tighten the introduction', 'Suggest a stronger title', 'Review for clarity and flow'],
  }), [props.workspace.name])

  return (
    <div className="writer-workspace" style={{ ['--writer-chat-pct' as any]: `${split}%` }}>
      <section className="writer-chat-panel" aria-label="writer chat">
        <ChatPane
          {...props}
          enabledSkills={enabledSkills}
          freshChat={freshChat}
        />
      </section>
      <Splitter orientation="vertical" onDrag={delta => setSplit(v => Math.max(28, Math.min(62, v + (delta / Math.max(1, window.innerWidth)) * 100)))} />
      <WriterDocumentEditor
        root={props.effectivePath || props.workspace.path}
        draftScope={`writer:${props.tabId}`}
        activeRel={activeRel}
        onActiveRelChange={setActiveRel}
        systemPrompt={systemPrompt}
        onSystemPromptChange={setSystemPrompt}
      />
    </div>
  )
}

interface WriterDocumentEditorProps {
  root: string
  draftScope: string
  activeRel: string | null
  onActiveRelChange: (rel: string | null) => void
  systemPrompt: string
  onSystemPromptChange: (value: string) => void
}

function WriterDocumentEditor({ root, draftScope, activeRel, onActiveRelChange, systemPrompt, onSystemPromptChange }: WriterDocumentEditorProps) {
  const [savedText, setSavedText] = useState('')
  const [draftText, setDraftText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const [newFormat, setNewFormat] = useState<WriterFormat>('md')
  const [fileTreeWidth, setFileTreeWidth] = useState(230)
  const [fileTreeOpen, setFileTreeOpen] = useState(true)
  const [fileTreeRevision, setFileTreeRevision] = useState(0)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [externalText, setExternalText] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourceOnly, setSourceOnly] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [editorKey, setEditorKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exporting, setExporting] = useState<'docx' | 'pdf' | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editorRef = useRef<MDXEditorMethods>(null)

  const updateDraft = useCallback((next: string) => {
    setDraftText(next)
    setDirty(next !== savedText)
  }, [savedText])

  const openFile = useCallback(async (rel: string) => {
    if (!root || !isWriterFile(rel)) return
    const api = window.electronAPI
    if (!api) return
    const lower = rel.toLowerCase()
    if (lower.endsWith('.docx') || lower.endsWith('.pdf')) {
      setError(null)
      setNotice(`Converting ${rel} to an editable Markdown working copy…`)
      const imported = await api.writerDocumentsImport(root, rel)
      if (!imported.ok || !imported.rel) {
        setNotice(null)
        setError(imported.error ?? 'failed to import document')
        return
      }
      const text = imported.markdown ?? ''
      onActiveRelChange(imported.rel)
      setSavedText(text)
      setDraftText(text)
      setDirty(false)
      setUnsaved(false)
      setExternalText(null)
      setReviewOpen(false)
      setParseError(null)
      setSourceOnly(looksRiskyForMdx(text))
      setEditorKey(k => k + 1)
      setFileTreeRevision(revision => revision + 1)
      setNotice(imported.reused
        ? `Reopened linked working copy ${imported.rel}; ${imported.sourceRel ?? rel} remains the preserved source.`
        : imported.warnings?.length
          ? `Imported ${rel} as ${imported.rel}. ${imported.warnings.join(' ')}`
          : `Imported ${rel} as ${imported.rel}; the original was left unchanged.`)
      return
    }
    const result = await api.fsReadFile(root, rel)
    if (result.error || !result.ok) {
      setError(result.error ?? 'failed to open file')
      return
    }
    const text = result.text ?? ''
    onActiveRelChange(rel)
    setSavedText(text)
    setDraftText(text)
    setDirty(false)
    setUnsaved(false)
    setReviewOpen(false)
    setExternalText(null)
    setParseError(null)
    setSourceOnly(isRichMarkdown(rel) ? looksRiskyForMdx(text) : true)
    setEditorKey(k => k + 1)
    setError(null)
    setNotice(null)
  }, [onActiveRelChange, root])

  const newDocument = useCallback(() => {
    const format = WRITER_FORMATS.find(f => f.id === newFormat) ?? WRITER_FORMATS[0]
    const workingExtension = format.binary ? 'md' : format.ext
    onActiveRelChange(`untitled.${workingExtension}`)
    setSavedText('')
    setDraftText('')
    setDirty(false)
    setUnsaved(true)
    setReviewOpen(false)
    setExternalText(null)
    setParseError(null)
    setSourceOnly(workingExtension !== 'md')
    setEditorKey(k => k + 1)
    setError(null)
    setNotice(format.binary
      ? `Creating an editable Markdown working copy. Approve and save it before exporting to ${format.label}.`
      : null)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [newFormat, onActiveRelChange])

  const saveAccepted = useCallback(async () => {
    if (!root || !activeRel) return
    const api = window.electronAPI
    if (!api) return
    const latest = isRichMarkdown(activeRel) && !sourceOnly
      ? (editorRef.current?.getMarkdown() ?? draftText)
      : draftText
    let targetRel = activeRel
    if (unsaved) {
      const existing = (await api.fsListFiles(root)).files ?? []
      const existingSet = new Set(existing)
      if (existingSet.has(targetRel)) {
        const dot = targetRel.lastIndexOf('.')
        const base = dot > -1 ? targetRel.slice(0, dot) : targetRel
        const ext = dot > -1 ? targetRel.slice(dot) : ''
        let n = 2
        while (existingSet.has(`${base}-${n}${ext}`)) n++
        targetRel = `${base}-${n}${ext}`
      }
    }
    const result = await api.fsWriteFile(root, targetRel, latest)
    if (result.error || !result.ok) {
      setError(result.error ?? 'failed to save document')
      return
    }
    onActiveRelChange(targetRel)
    setSavedText(latest)
    setDraftText(latest)
    setDirty(false)
    setUnsaved(false)
    setReviewOpen(false)
    setExternalText(null)
    setFileTreeRevision(revision => revision + 1)
    setError(null)
    clearMarkdownDraft(draftScope)
  }, [activeRel, draftScope, draftText, onActiveRelChange, root, sourceOnly, unsaved])

  const rejectDraft = useCallback(async () => {
    if (externalText !== null && root && activeRel) {
      const result = await window.electronAPI?.fsWriteFile(root, activeRel, savedText)
      if (!result?.ok) {
        setError(result?.error ?? 'failed to restore document')
        return
      }
      setExternalText(null)
      setReviewOpen(false)
      setNotice(dirty ? 'Agent changes denied; your local draft was preserved.' : 'Agent changes denied; the approved document was restored.')
      // A local draft remains intact; only the agent's on-disk version is denied.
      if (!dirty) {
        setDraftText(savedText)
        setEditorKey(k => k + 1)
      }
      return
    }
    setDraftText(savedText)
    setDirty(false)
    setReviewOpen(false)
    setEditorKey(k => k + 1)
    clearMarkdownDraft(draftScope)
  }, [activeRel, dirty, draftScope, externalText, root, savedText])

  const acceptReview = useCallback(async () => {
    if (externalText === null) {
      await saveAccepted()
      return
    }
    setSavedText(externalText)
    setDraftText(externalText)
    setDirty(false)
    setUnsaved(false)
    setExternalText(null)
    setReviewOpen(false)
    setEditorKey(k => k + 1)
    setError(null)
    setNotice('Agent changes accepted as the approved document.')
    clearMarkdownDraft(draftScope)
  }, [draftScope, externalText, saveAccepted])

  const exportDocument = useCallback(async (format: 'docx' | 'pdf') => {
    if (!activeRel || dirty || unsaved || externalText !== null) return
    setExporting(format)
    setError(null)
    const result = await window.electronAPI?.writerDocumentsExport(root, activeRel, savedText, format)
    setExporting(null)
    if (!result?.ok || !result.rel) {
      setError(result?.error ?? `failed to export ${format.toUpperCase()}`)
      return
    }
    setFileTreeRevision(revision => revision + 1)
    setNotice(`Exported approved document to ${result.rel}.`)
  }, [activeRel, dirty, externalText, root, savedText, unsaved])

  useEffect(() => {
    const draft = loadMarkdownDraft(draftScope, root)
    if (draft && draft.rel && (draft.dirty || draft.unsaved)) {
      // Writer panes can remount during workspace refreshes; keep unsaved text in-app
      // instead of pretending the file vanished because it has not been saved yet.
      onActiveRelChange(draft.rel)
      setSavedText(draft.savedText ?? '')
      setDraftText(draft.text)
      setDirty(draft.dirty)
      setUnsaved(draft.unsaved)
      setReviewOpen(false)
      setExternalText(null)
      setParseError(draft.parseError ?? null)
      setSourceOnly(draft.sourceOnly)
      setEditorKey(k => k + 1)
      setError(null)
      return
    }
    onActiveRelChange(null)
    setSavedText('')
    setDraftText('')
    setDirty(false)
    setUnsaved(false)
    setReviewOpen(false)
    setExternalText(null)
  }, [draftScope, root, onActiveRelChange])

  useEffect(() => {
    if (!root || !activeRel) return
    if (dirty || unsaved) {
      saveMarkdownDraft(draftScope, {
        root,
        rel: activeRel,
        text: draftText,
        savedText,
        dirty,
        unsaved,
        sourceOnly,
        parseError,
      })
      return
    }
    clearMarkdownDraft(draftScope)
  }, [activeRel, dirty, draftScope, draftText, parseError, root, savedText, sourceOnly, unsaved])

  useEffect(() => {
    if (!root || !activeRel || unsaved) return
    const api = window.electronAPI
    if (!api) return
    let checking = false
    const checkDisk = async (): Promise<void> => {
      if (checking) return
      checking = true
      try {
        const result = await api.fsReadFile(root, activeRel)
        const latest = result.ok ? (result.text ?? '') : null
        if (latest === null || latest === savedText || latest === externalText) return
        setExternalText(latest)
        setReviewOpen(true)
        setNotice(dirty
          ? 'An agent changed this file while you have a local draft. Review carefully: accepting uses the agent version; denying keeps your draft.'
          : 'An agent changed the active document. Review the on-disk changes before continuing.')
      } finally {
        checking = false
      }
    }

    if (root.includes('://')) {
      // Remote workspaces have no local filesystem events, so bounded polling
      // keeps agent edits reviewable without requiring software on the host.
      const timer = window.setInterval(() => { void checkDisk() }, 2_000)
      return () => window.clearInterval(timer)
    }

    api.editorWatchAdd(root, activeRel)
    const unsubscribe = api.onEditorFileChanged(event => {
      if (event.root === root && event.rel.replace(/\\/g, '/') === activeRel.replace(/\\/g, '/')) void checkDisk()
    })
    return () => {
      unsubscribe()
      api.editorWatchRemove(root, activeRel)
    }
  }, [activeRel, dirty, externalText, root, savedText, unsaved])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.userAgent.includes('Mac')
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (!activeRel) return
        e.preventDefault()
        setReviewOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeRel])

  const localReviewText = isRichMarkdown(activeRel) && !sourceOnly
    ? (editorRef.current?.getMarkdown() ?? draftText)
    : draftText
  const reviewText = externalText ?? localReviewText
  const patch = useMemo(
    () => createPatch(activeRel ?? 'untitled.md', savedText, reviewText, 'approved', externalText !== null ? 'agent version' : 'draft'),
    [activeRel, externalText, reviewText, savedText],
  )
  const formatMeta = activeRel?.toLowerCase().endsWith('.txt') ? 'plain text' : isRichMarkdown(activeRel) ? 'rich markdown' : 'document'
  const exportDisabled = !activeRel || dirty || unsaved || externalText !== null || exporting !== null

  return (
    <section className="writer-doc-panel" aria-label="writer document editor">
      <div className="writer-doc-toolbar">
        <div className="writer-doc-title">
          <span className="writer-kicker">Writers Workspace</span>
          <strong>{activeRel ? (unsaved ? `${activeRel} (unsaved)` : activeRel) : 'no document selected'}</strong>
          {(dirty || externalText !== null) && <span className="ed-dirty" title={externalText !== null ? 'agent changes awaiting review' : 'unsaved draft'}>●</span>}
          <span className="writer-file-kind">{formatMeta}</span>
        </div>
          <WriterFormatDropdown value={newFormat} onChange={setNewFormat} />
        <div className="writer-doc-actions">
          <button type="button" className="writer-btn" onClick={newDocument}>
            <Icon name="plus" size={13} />Create File
          </button>
          <button type="button" className="writer-btn" onClick={() => setSettingsOpen(true)}>
            <Icon name="sliders" size={13} />System Prompt
          </button>
          <button type="button" className="writer-btn" disabled={exportDisabled} onClick={() => void exportDocument('docx')}>
            <Icon name="fileText" size={13} />{exporting === 'docx' ? 'Exporting…' : 'DOCX'}
          </button>
          <button type="button" className="writer-btn" disabled={exportDisabled} onClick={() => void exportDocument('pdf')}>
            <Icon name="fileText" size={13} />{exporting === 'pdf' ? 'Exporting…' : 'PDF'}
          </button>
          <button type="button" className="writer-btn writer-btn-primary" disabled={!activeRel || (!dirty && !unsaved && externalText === null)} onClick={() => setReviewOpen(true)}>
            <Icon name="branch" size={13} />Review Changes
          </button>
          <button
            type="button"
            className={`writer-btn writer-btn-ghost writer-tree-toggle ${fileTreeOpen ? 'on' : ''}`}
            aria-pressed={fileTreeOpen}
            title={fileTreeOpen ? 'hide file tree' : 'show file tree'}
            onClick={() => setFileTreeOpen(open => !open)}
          >
            <Icon name="sidebar" size={14} />
          </button>
        </div>
      </div>

      {error && <div className="writer-error">{error}</div>}
      {notice && <div className="writer-notice">{notice}</div>}

      <div className="writer-doc-body">
        <div className="writer-editor-wrap">
          {!activeRel ? (
            <div className="writer-empty">
              <span className="writer-empty-badge">Content Studio</span>
              <h2>Choose a format above, then start writing</h2>
              {/* <div className="writer-empty-actions">
                <button type="button" className="writer-btn writer-btn-primary" onClick={newDocument}>create {WRITER_FORMATS.find(f => f.id === newFormat)?.label}</button>
                <button type="button" className="writer-btn writer-btn-secondary" onClick={() => setSettingsOpen(true)}>Tune prompt</button>
              </div> */}
            </div>
          ) : isRichMarkdown(activeRel) && !sourceOnly ? (
            <div className="writer-rich-editor mdx-host">
              <MDXEditor
                key={editorKey}
                ref={editorRef}
                markdown={draftText}
                onChange={(md) => {
                  updateDraft(md)
                  saveMarkdownDraft(draftScope, {
                    root,
                    rel: activeRel,
                    text: md,
                    savedText,
                    dirty: md !== savedText,
                    unsaved,
                    sourceOnly,
                    parseError,
                  })
                }}
                onError={(payload) => {
                  setTimeout(() => {
                    setParseError(payload.error)
                    setSourceOnly(true)
                    setEditorKey(k => k + 1)
                  }, 0)
                }}
                contentEditableClassName="mdx-content writer-mdx-content"
                className="mdx-root dark-theme dark-editor writer-mdx-root"
                plugins={[
                  headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(), markdownShortcutPlugin(),
                  linkPlugin(), linkDialogPlugin(), imagePlugin(), tablePlugin(), frontmatterPlugin(),
                  codeBlockPlugin({ defaultCodeBlockLanguage: 'md' }), codeMirrorPlugin({ codeBlockLanguages: CODE_LANGS }),
                  diffSourcePlugin({ viewMode: 'rich-text', diffMarkdown: savedText }),
                  toolbarPlugin({ toolbarContents: () => (
                    <DiffSourceToggleWrapper>
                      <UndoRedo />
                      <BoldItalicUnderlineToggles />
                      <BlockTypeSelect />
                      <ListsToggle />
                      <CreateLink />
                      <InsertImage />
                      <InsertTable />
                      <InsertThematicBreak />
                      <InsertCodeBlock />
                    </DiffSourceToggleWrapper>
                  ) }),
                ]}
              />
            </div>
          ) : (
            <div className="writer-source-wrap">
              {parseError && <div className="writer-source-note">rich editor paused: {parseError}</div>}
              <textarea
                ref={textareaRef}
                className="writer-textarea"
                value={draftText}
                spellCheck
                onChange={(e) => updateDraft(e.target.value)}
              />
            </div>
          )}
        </div>
        {fileTreeOpen && (
          <>
            <Splitter orientation="vertical" onDrag={delta => setFileTreeWidth(w => Math.max(170, Math.min(440, w - delta)))} />
            <FileTree root={root} activeRel={activeRel ?? undefined} onSelect={openFile} width={fileTreeWidth} fileFilter={isWriterFile} refreshKey={fileTreeRevision} />
          </>
        )}
      </div>

      {reviewOpen && (
        <div className="writer-review-modal" role="dialog" aria-modal="true" aria-label="review document changes">
          <div className="writer-review-card">
            <div className="writer-review-head">
              <div>
                <span className="writer-kicker">{externalText !== null ? 'agent edit review' : 'draft review'}</span>
                <h2>{activeRel ?? 'untitled.md'}</h2>
                {externalText !== null && dirty && <p>Accepting replaces your local draft with the agent version. Denying restores the approved file and keeps your draft.</p>}
              </div>
              <button type="button" className="writer-btn writer-btn-ghost" onClick={() => setReviewOpen(false)}>close</button>
            </div>
            <div className="writer-review-diff"><PierreDiff patch={patch} /></div>
            <div className="writer-review-actions">
              <button type="button" className="writer-btn writer-btn-danger" onClick={() => void rejectDraft()}>deny changes</button>
              <button type="button" className="writer-btn writer-btn-primary" onClick={() => void acceptReview()}>{externalText !== null ? 'accept agent version' : 'accept & save'}</button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="writer-review-modal" role="dialog" aria-modal="true" aria-label="writer system prompt settings">
          <div className="writer-settings-card">
            <div className="writer-review-head writer-settings-head">
              <div>
                <span className="writer-kicker">settings</span>
                <h2>Writers system prompt</h2>
                <p>This prompt is injected into Writers chat to keep models focused on content creation and reviewed document edits.</p>
              </div>
              <button type="button" className="writer-btn writer-btn-ghost" onClick={() => setSettingsOpen(false)}>done</button>
            </div>
            <textarea className="writer-prompt-textarea" value={systemPrompt} onChange={(e) => onSystemPromptChange(e.target.value)} />
            <div className="writer-review-actions">
              <button type="button" className="writer-btn writer-btn-secondary" onClick={() => onSystemPromptChange(DEFAULT_WRITER_PROMPT)}>restore default</button>
              <button type="button" className="writer-btn writer-btn-primary" onClick={() => setSettingsOpen(false)}>save prompt</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
