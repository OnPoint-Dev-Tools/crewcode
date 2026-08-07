import React, { useCallback, useEffect, useRef, useState } from 'react'
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
  DiffSourceToggleWrapper
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import { FileTree } from './FileTree'
import { Splitter } from '../chat/Splitter'
import { Icon } from '../ui/Icon'
import { clearMarkdownDraft, loadMarkdownDraft, saveMarkdownDraft } from './markdown-draft-storage'
import type { RegisteredPluginEditorAction } from '../../../../shared/plugin-types'

interface MarkdownEditorProps {
  root?: string
  /** Stable per-tab key; the open markdown file is remembered under it across remounts. */
  persistKey?: string
  pluginEditorActions?: RegisteredPluginEditorAction[]
  onPluginEditorAction?: (action: RegisteredPluginEditorAction, rel: string | null) => void
}

// Remember which markdown file each chat tab had open. Chat panes unmount on tab
// switch, so without this the editor reopens empty every time you come back.
const MD_OPEN_STORAGE = 'crewcode:mdEditorOpen:v1'

function loadMdOpen(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MD_OPEN_STORAGE)
    if (raw) return JSON.parse(raw)
  } catch {}
  return {}
}

function persistMdOpen(key: string, rel: string | null): void {
  try {
    const all = loadMdOpen()
    if (rel) all[key] = rel
    else delete all[key]
    localStorage.setItem(MD_OPEN_STORAGE, JSON.stringify(all))
  } catch { /* quota — non-fatal */ }
}

// Remember which file-tree folders each chat tab had expanded, so the tree restores
// its shape on remount the same way the code editor's tree does.
const MD_TREE_STORAGE = 'crewcode:mdEditorTree:v1'

function loadMdTree(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(MD_TREE_STORAGE)
    if (raw) return JSON.parse(raw)
  } catch {}
  return {}
}

function persistMdTree(key: string, dirs: string[]): void {
  try {
    const all = loadMdTree()
    if (dirs.length > 0) all[key] = dirs
    else delete all[key]
    localStorage.setItem(MD_TREE_STORAGE, JSON.stringify(all))
  } catch { /* quota — non-fatal */ }
}

const CODE_LANGS = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
  md: 'Markdown',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  sh: 'Shell',
  bash: 'Bash',
  yaml: 'YAML',
  toml: 'TOML',
  sql: 'SQL',
  '': 'Plain text'
}

export function MarkdownEditor({ root, persistKey, pluginEditorActions = [], onPluginEditorAction }: MarkdownEditorProps) {
  const [rel, setRel] = useState<string | null>(null)
  const [src, setSrc] = useState('')
  const [dirty, setDirty] = useState(false)
  // True when `rel` is a virtual untitled buffer that hasn't been written to disk yet.
  const [unsaved, setUnsaved] = useState(false)
  const [ftWidth, setFtWidth] = useState(220)
  const [editorKey, setEditorKey] = useState(0)
  const [sourceOnly, setSourceOnly] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const editorRef = useRef<MDXEditorMethods>(null)
  const currentSrcRef = useRef('')
  // True while an async restore is in flight, so the persist effect doesn't write the
  // transient null state and delete the saved file before we reopen it.
  const pendingRestoreRef = useRef(false)

  // Seed the file tree's expansion from storage so restored folders match what the
  // user left open; persist back whenever the tree reports a change.
  const [expandedDirs] = useState<string[]>(() => (persistKey ? loadMdTree()[persistKey] ?? [] : []))
  const draftScope = persistKey ? `chat:${persistKey}` : null

  const onExpandedDirsChange = useCallback((dirs: string[]) => {
    if (persistKey) persistMdTree(persistKey, dirs)
  }, [persistKey])

  const onFtDrag = useCallback((delta: number) => {
    setFtWidth(w => Math.max(140, Math.min(500, w - delta)))
  }, [])

  const looksRiskyForMdx = (text: string): boolean => {
    // MDX/JSX parser chokes on stray `<` that aren't valid HTML/JSX starts.
    // Heuristic: a `<` followed by anything other than a letter, `!`, `/`, or `>` is risky.
    // Also flag `</` followed by a non-letter (closing tags with bad names).
    return /<(?![a-zA-Z!\/>])/m.test(text) || /<\/(?![a-zA-Z>])/m.test(text)
  }

  const open = useCallback(async (targetRel: string) => {
    if (!root) return
    if (!targetRel.endsWith('.md') && !targetRel.endsWith('.mdx')) return
    const api = window.electronAPI
    if (!api) return
    const r = await api.fsReadFile(root, targetRel)
    setParseError(null)
    if (r.error || !r.ok) {
      const errText = `<${r.error}>`
      setRel(targetRel)
      setSrc(errText)
      currentSrcRef.current = errText
      setUnsaved(false)
      setSourceOnly(true)
      setEditorKey(k => k + 1)
      return
    }
    const text = r.text ?? ''
    setRel(targetRel)
    setSrc(text)
    currentSrcRef.current = text
    setDirty(false)
    setUnsaved(false)
    setSourceOnly(looksRiskyForMdx(text))
    setEditorKey(k => k + 1)
  }, [root])

  // Open an in-memory untitled.md buffer. Nothing is written to disk until
  // the user saves; on save we land at `root/untitled.md` (or untitled-N.md
  // if that name is already taken).
  const newUntitled = useCallback(() => {
    setRel('untitled.md')
    setSrc('')
    currentSrcRef.current = ''
    setDirty(false)
    setUnsaved(true)
    setParseError(null)
    setSourceOnly(false)
    setEditorKey(k => k + 1)
  }, [])

  const save = useCallback(async () => {
    if (!root || !rel) return
    if (!dirty && !unsaved) return
    const api = window.electronAPI
    if (!api) return
    const latest = editorRef.current?.getMarkdown() ?? currentSrcRef.current
    let targetRel = rel
    if (unsaved) {
      // Pick a non-clobbering filename so we don't overwrite an existing untitled.md.
      const existing = (await api.fsListFiles(root)).files ?? []
      const existingSet = new Set(existing)
      if (existingSet.has(targetRel)) {
        let n = 2
        while (existingSet.has(`untitled-${n}.md`)) n++
        targetRel = `untitled-${n}.md`
      }
    }
    await api.fsWriteFile(root, targetRel, latest)
    setRel(targetRel)
    setSrc(latest)
    currentSrcRef.current = latest
    setDirty(false)
    setUnsaved(false)
    if (draftScope) clearMarkdownDraft(draftScope)
  }, [root, rel, dirty, unsaved, draftScope])

  // On mount / workspace change, reopen the file this tab last had open instead of
  // landing on the empty picker. Falls back to a clean slate when nothing is saved.
  useEffect(() => {
    if (!root) {
      setRel(null)
      setSrc('')
      currentSrcRef.current = ''
      setDirty(false)
      setUnsaved(false)
      return
    }
    const draft = draftScope ? loadMarkdownDraft(draftScope, root) : null
    if (draft && draft.rel && (draft.dirty || draft.unsaved)) {
      // Unsaved buffers have no disk identity; restore them from the per-tab draft cache.
      setRel(draft.rel)
      setSrc(draft.text)
      currentSrcRef.current = draft.text
      setDirty(draft.dirty)
      setUnsaved(draft.unsaved)
      setParseError(draft.parseError ?? null)
      setSourceOnly(draft.sourceOnly)
      setEditorKey(k => k + 1)
      return
    }
    const saved = persistKey ? loadMdOpen()[persistKey] : null
    if (saved) {
      pendingRestoreRef.current = true
      void open(saved).finally(() => { pendingRestoreRef.current = false })
      return
    }
    setRel(null)
    setSrc('')
    currentSrcRef.current = ''
    setDirty(false)
    setUnsaved(false)
  }, [root, persistKey, open, draftScope])

  // Track the open file per tab. Dirty/untitled content is also cached separately
  // because there may be nothing on disk to reopen after a pane refresh.
  useEffect(() => {
    if (!persistKey || pendingRestoreRef.current) return
    persistMdOpen(persistKey, unsaved ? null : rel)
  }, [rel, unsaved, persistKey])

  useEffect(() => {
    if (!draftScope || !root || pendingRestoreRef.current) return
    if (rel && (dirty || unsaved)) {
      saveMarkdownDraft(draftScope, {
        root,
        rel,
        text: currentSrcRef.current,
        dirty,
        unsaved,
        sourceOnly,
        parseError,
      })
      return
    }
    clearMarkdownDraft(draftScope)
  }, [draftScope, root, rel, src, dirty, unsaved, sourceOnly, parseError])

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const isMac = navigator.userAgent.includes('Mac')
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [save])

  if (!root) {
    return (
      <div className="ed-shell">
        <div className="ed-pathbar"><span className="ed-path">no workspace selected</span></div>
      </div>
    )
  }

  const path = rel
    ? (unsaved ? `${rel} (unsaved)` : `${root}/${rel}`)
    : root

  return (
    <div className="ed-shell">
      <div className="ed-pathbar">
        <span className="ed-path">{path}</span>
        {(dirty || unsaved) && <span className="ed-dirty" title="unsaved changes">●</span>}
        {(sourceOnly || parseError) && (
          <span className="ed-warn" title={parseError ?? 'contains JSX-like content — rich mode disabled'}>
            source-only
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ed-new-btn"
          onClick={newUntitled}
          title="new markdown file"
        >
         <Icon name="plus" size={14} stroke={2} />
          Md file
        </button>
      </div>

      <div className="ed-main">
        <div className="md-shell mdx-host">
          {!rel && (
            <div className="ed-empty">
              select a markdown file from the tree
              <button type="button" className="ed-empty-action" onClick={newUntitled}>
                or start an untitled.md
              </button>
            </div>
          )}
          {rel && sourceOnly && (
            <div className="mdx-fallback">
              <div className="mdx-fallback-bar">
                <span>
                  {parseError ? 'rich mode unavailable — file contains JSX-like content' : 'source-only mode'}
                </span>
                <button
                  className="mdx-fallback-retry"
                  onClick={() => {
                    setParseError(null)
                    setSourceOnly(false)
                    setEditorKey(k => k + 1)
                  }}
                  title="try rich text mode"
                >
                  try rich mode
                </button>
              </div>
              <textarea
                className="mdx-fallback-textarea"
                value={src}
                spellCheck={false}
                onChange={(e) => {
                  const v = e.target.value
                  setSrc(v)
                  currentSrcRef.current = v
                  setDirty(true)
                }}
              />
            </div>
          )}
          {rel && !sourceOnly && (
            <div className="mdx-scroll-viewport">
              <MDXEditor
                key={editorKey}
                ref={editorRef}
                markdown={src}
                onChange={(md) => {
                  currentSrcRef.current = md
                  if (md !== src) setDirty(true)
                  if (draftScope && root && rel) {
                    saveMarkdownDraft(draftScope, {
                      root,
                      rel,
                      text: md,
                      dirty: md !== src || dirty,
                      unsaved,
                      sourceOnly,
                      parseError,
                    })
                  }
                }}
                onError={(payload) => {
                  // Defer to avoid setState during render
                  setTimeout(() => {
                    setParseError(payload.error)
                    if (!sourceOnly) {
                      setSourceOnly(true)
                      setEditorKey(k => k + 1)
                    }
                  }, 0)
                }}
                contentEditableClassName="mdx-content"
                className="mdx-root dark-theme dark-editor"
                plugins={[
                  headingsPlugin(),
                  listsPlugin(),
                  quotePlugin(),
                  thematicBreakPlugin(),
                  markdownShortcutPlugin(),
                  linkPlugin(),
                  linkDialogPlugin(),
                  imagePlugin(),
                  tablePlugin(),
                  frontmatterPlugin(),
                  codeBlockPlugin({ defaultCodeBlockLanguage: 'ts' }),
                  codeMirrorPlugin({ codeBlockLanguages: CODE_LANGS }),
                  diffSourcePlugin({
                    viewMode: sourceOnly ? 'source' : 'rich-text',
                    diffMarkdown: src
                  }),
                  toolbarPlugin({
                    toolbarContents: () => (
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
                        {rel && pluginEditorActions.map(action => (
                          <button
                            key={action.registrationId}
                            type="button"
                            title={`${action.title} · ${action.pluginId}`}
                            onClick={() => onPluginEditorAction?.(action, rel)}
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 0, background: 'transparent', color: 'inherit' }}
                          >
                            <Icon name="plug" size={14} />
                          </button>
                        ))}
                      </DiffSourceToggleWrapper>
                    )
                  })
                ]}
              />
            </div>
          )}
        </div>
        <Splitter orientation="vertical" onDrag={onFtDrag} />
        <FileTree
          root={root}
          activeRel={rel ?? undefined}
          onSelect={open}
          width={ftWidth}
          fileFilter={name => name.endsWith('.md') || name.endsWith('.mdx')}
          expandedDirs={expandedDirs}
          onExpandedDirsChange={onExpandedDirsChange}
        />
      </div>
    </div>
  )
}
