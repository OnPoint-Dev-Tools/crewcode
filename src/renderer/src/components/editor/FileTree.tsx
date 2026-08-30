import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  FilePlusIcon, FolderPlusIcon, ScissorsIcon, CopyIcon, ClipboardIcon, ClipboardTextIcon, PencilIcon, TrashIcon
} from '@phosphor-icons/react'
import { Icon } from '../ui/Icon'
import { BeardedFileIcon } from './bearded-file-icons'
import type { EditorOutlineSymbol } from './editor-outline'
import type { FsNode } from '../../types'
import { canPasteInto, parentRel, pasteTargetDirRel, type TreeClipboard } from './file-tree-clipboard'

interface SearchResult {
  rel: string
  name: string
  line: number
  text: string
}

interface FileTreeProps {
  root:         string
  activeRel?:   string
  onSelect:     (rel: string) => void
  onSelectLine?: (rel: string, line: number, term: string, caseSensitive: boolean) => void
  onDiff?:      (title: string, diff: string) => void
  width?:       number
  fileFilter?:  (name: string) => boolean
  openTabs?:    string[]
  outlineSymbols?: EditorOutlineSymbol[]
  outlineFileName?: string
  onSelectOutline?: (symbol: EditorOutlineSymbol) => void
  dirtyRels?: string[]
  onReplaceApplied?: (rels: string[]) => void
  /** Directory rels to expand on mount, so the tree restores the shape the user left. */
  expandedDirs?: string[]
  /** Reports the current set of expanded directory rels whenever it changes. */
  onExpandedDirsChange?: (rels: string[]) => void
  /** Reloads visible directories after another surface creates filesystem entries. */
  refreshKey?: string | number
}

interface DirState {
  open:     boolean
  loading:  boolean
  children: FsNode[]
  error:    string | null
}

interface DirCache {
  [rel: string]: DirState
}

type NewKind = 'file' | 'folder' | null

interface CtxMenu {
  x:      number
  y:      number
  node:   FsNode | null
  isDir:  boolean
}

function parentOf(rel: string): string {
  return parentRel(rel)
}

function isAncestorOf(ancestor: string, target: string): boolean {
  if (!ancestor) return true                           // root is ancestor of everything
  return target === ancestor || target.startsWith(ancestor + '/')
}

export function FileTree({ root, activeRel, onSelect, onSelectLine, onDiff, width, fileFilter, openTabs, outlineSymbols = [], outlineFileName, onSelectOutline, dirtyRels = [], onReplaceApplied, expandedDirs, onExpandedDirsChange, refreshKey }: FileTreeProps) {
  const [panel,       setPanel]       = useState<'files' | 'outline' | 'search'>('files')
  const [cache,       setCache]       = useState<DirCache>({})
  const [rootErr,     setRootErr]     = useState<string | null>(null)
  const [newKind,     setNewKind]     = useState<NewKind>(null)
  const [newName,     setNewName]     = useState('')
  const [newParent,   setNewParent]   = useState('')
  const [renameRel,   setRenameRel]   = useState<string | null>(null)
  const [renameName,  setRenameName]  = useState('')
  const [ctx,         setCtx]         = useState<CtxMenu | null>(null)
  const [clipboard,   setClipboard]   = useState<TreeClipboard | null>(null)
  const [selectedRel, setSelectedRel] = useState<string | null>(null)
  const [dragSrc,     setDragSrc]     = useState<FsNode | null>(null)
  const [dropTarget,  setDropTarget]  = useState<string | null>(null)  // rel of hovered dir, '' = root
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCase,  setSearchCase]  = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [replaceBusy, setReplaceBusy] = useState(false)
  const [searchScope, setSearchScope] = useState<'all' | 'selected'>('all')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError,   setSearchError]   = useState<string | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSnapshotsRef = useRef<Map<string, string>>(new Map())
  const openTabsRef = useRef(openTabs)
  openTabsRef.current = openTabs
  // Latest persisted expansion, read at root-change time without re-triggering restore.
  const expandedDirsRef = useRef(expandedDirs)
  expandedDirsRef.current = expandedDirs
  // While restoring we mute the change-reporter so a transient empty cache doesn't
  // clobber the persisted set before the saved dirs are re-opened.
  const restoringRef = useRef(false)
  const expandedReportRef = useRef<string | null>(null)
  const newInputRef    = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const ctxRef         = useRef<HTMLDivElement>(null)

  const loadDir = useCallback(async (rel: string) => {
    const api = window.electronAPI
    if (!api) return
    setCache(prev => ({
      ...prev,
      [rel]: { open: true, loading: true, children: prev[rel]?.children ?? [], error: null }
    }))
    const result = await api.fsReadDir(root, rel)
    if (result.error) {
      if (rel === '') setRootErr(result.error)
      setCache(prev => ({ ...prev, [rel]: { open: true, loading: false, children: [], error: result.error! } }))
      return
    }
    setCache(prev => ({ ...prev, [rel]: { open: true, loading: false, children: result.nodes ?? [], error: null } }))
  }, [root])

  // ── Global search ───────────────────────────────────────────────────────────

  const runSearch = useCallback(async (query: string, caseSensitive: boolean, scope: 'all' | 'selected') => {
    const api = window.electronAPI
    if (!api || !root || !query.trim()) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }
    setSearchLoading(true)
    setSearchError(null)
    try {
      let files: string[]
      if (scope === 'selected') {
        files = (openTabsRef.current ?? []).slice(0, 200)
      } else {
        const list = await api.fsListFiles(root)
        if (list.error || !list.files) {
          setSearchError(list.error ?? 'failed to list files')
          setSearchResults([])
          setSearchLoading(false)
          return
        }
        files = list.files.slice(0, 2000)
      }
      const results: SearchResult[] = []
      const snapshots = new Map<string, string>()
      const q = caseSensitive ? query.trim() : query.trim().toLowerCase()
      const maxFiles = 200
      const maxResults = 100
      let filesRead = 0
      for (const rel of files) {
        if (results.length >= maxResults) break
        if (filesRead >= maxFiles) break
        // Skip binary-ish extensions
        const ext = rel.split('.').pop()?.toLowerCase() ?? ''
        const binaryExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'webm', 'ogg', 'wav', 'pdf', 'zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'wasm', 'map'])
        if (binaryExts.has(ext)) continue
        filesRead++
        const r = await api.fsReadFile(root, rel)
        if (r.error || !r.ok || typeof r.text !== 'string') continue
        const text = r.text as string
        if (text.length > 500_000) continue
        snapshots.set(rel, text)
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = caseSensitive ? lines[i] : lines[i].toLowerCase()
          if (line.includes(q)) {
            results.push({ rel, name: r.name ?? rel, line: i + 1, text: lines[i].slice(0, 120) })
            if (results.length >= maxResults) break
          }
        }
      }
      searchSnapshotsRef.current = snapshots
      setSearchResults(results)
    } catch (e: any) {
      setSearchError(e?.message ?? 'search failed')
      setSearchResults([])
    }
    setSearchLoading(false)
  }, [root])

  const applyReplacement = useCallback(async () => {
    const api = window.electronAPI
    const query = searchQuery.trim()
    if (!api || !root || !query || replaceBusy) return
    const affected = [...new Set(searchResults.map(result => result.rel))]
    const dirty = affected.filter(rel => dirtyRels.includes(rel))
    if (dirty.length) { setSearchError(`save affected files first: ${dirty.join(', ')}`); return }
    setReplaceBusy(true)
    setSearchError(null)
    const originals = new Map<string, string>()
    const written: string[] = []
    try {
      for (const rel of affected) {
        const current = await api.fsReadFile(root, rel)
        const snapshot = searchSnapshotsRef.current.get(rel)
        if (!current.ok || typeof current.text !== 'string' || snapshot == null || current.text !== snapshot) throw new Error(`${rel} changed since the preview`)
        originals.set(rel, current.text)
        const needle = searchCase ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const next = searchCase ? current.text.split(query).join(replaceText) : current.text.replace(new RegExp(needle, 'gi'), replaceText)
        const result = await api.fsWriteFile(root, rel, next)
        if (!result.ok) throw new Error(result.error ?? `failed to write ${rel}`)
        written.push(rel)
      }
      onReplaceApplied?.(written)
      await runSearch(query, searchCase, searchScope)
    } catch (error) {
      for (const rel of [...written].reverse()) {
        const original = originals.get(rel)
        if (original != null) await api.fsWriteFile(root, rel, original)
      }
      setSearchError(error instanceof Error ? error.message : 'replace failed')
    } finally { setReplaceBusy(false) }
  }, [root, searchQuery, replaceText, replaceBusy, searchResults, dirtyRels, searchCase, searchScope, onReplaceApplied, runSearch])

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const query = searchQuery.trim()
    if (!query) {
      // Only clear state if it isn't already empty — avoids re-renders while typing
      setSearchResults(prev => prev.length === 0 ? prev : [])
      setSearchLoading(false)
      setSearchError(null)
      return
    }
    searchTimerRef.current = setTimeout(() => {
      void runSearch(query, searchCase, searchScope)
    }, 300)
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [searchQuery, searchCase, searchScope, runSearch])

  useEffect(() => {
    setCache({})
    setRootErr(null)
    setClipboard(null)
    expandedReportRef.current = null
    if (!root) return
    restoringRef.current = true
    void (async () => {
      await loadDir('')
      // Re-open saved dirs shallowest-first so each parent's children exist before
      // we expand the child sitting inside them.
      const toRestore = (expandedDirsRef.current ?? [])
        .filter(Boolean)
        .sort((a, b) => a.split('/').length - b.split('/').length)
      for (const rel of toRestore) await loadDir(rel)
      restoringRef.current = false
    })()
  }, [root, loadDir, refreshKey])

  // Persist the user's expansion shape. Muted during restore so the reset-then-reopen
  // cycle never reports an empty set and wipes what we're about to restore.
  useEffect(() => {
    if (!onExpandedDirsChange || restoringRef.current) return
    const open = Object.entries(cache)
      .filter(([rel, state]) => rel && state.open)
      .map(([rel]) => rel)
      .sort()
    const key = open.join('\n')
    if (key === expandedReportRef.current) return
    expandedReportRef.current = key
    onExpandedDirsChange(open)
  }, [cache, onExpandedDirsChange])

  useEffect(() => {
    if (newKind) newInputRef.current?.focus()
  }, [newKind, cache])

  useEffect(() => {
    if (renameRel !== null) renameInputRef.current?.focus()
  }, [renameRel])

  useEffect(() => {
    if (!ctx) return
    const close = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtx(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [ctx])

  const toggle = (rel: string, isDir: boolean) => {
    if (!isDir) { setSelectedRel(rel); onSelect(rel); return }
    setSelectedRel(rel)
    const state = cache[rel]
    if (!state) { loadDir(rel); return }
    if (state.open) {
      setCache(prev => ({ ...prev, [rel]: { ...prev[rel], open: false } }))
    } else {
      if (state.children.length === 0 && !state.error) loadDir(rel)
      else setCache(prev => ({ ...prev, [rel]: { ...prev[rel], open: true } }))
    }
  }

  function openCtx(e: React.MouseEvent, node: FsNode | null, isDir: boolean) {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, node, isDir })
  }

  function startNew(kind: NewKind, parentRel: string) {
    setCtx(null)
    setNewKind(kind)
    setNewName('')
    setNewParent(parentRel)
    if (!parentRel) return
    const state = cache[parentRel]
    if (!state) {
      loadDir(parentRel)
    } else if (!state.open) {
      setCache(prev => ({ ...prev, [parentRel]: { ...prev[parentRel], open: true } }))
    }
  }

  async function commitNew() {
    const api    = window.electronAPI
    const kind   = newKind
    const name   = newName.trim()
    const parent = newParent
    cancelNew()
    if (!api || !kind || !name) return
    const rel = parent ? `${parent}/${name}` : name
    if (kind === 'folder') {
      await api.fsMkdir(root, rel)
    } else {
      await api.fsWriteFile(root, rel, '')
    }
    loadDir(parent)
    if (kind === 'file') onSelect(rel)
  }

  function cancelNew() {
    setNewKind(null)
    setNewName('')
  }

  function startRename(node: FsNode) {
    setCtx(null)
    setRenameRel(node.rel)
    setRenameName(node.name)
  }

  async function commitRename() {
    const rel  = renameRel
    const name = renameName.trim()
    cancelRename()
    const api = window.electronAPI
    if (!api || !rel || !name) return
    const result = await api.fsRename(root, rel, name)
    loadDir(parentOf(rel))
    if (result.rel && activeRel === rel) onSelect(result.rel)
  }

  function cancelRename() {
    setRenameRel(null)
    setRenameName('')
  }

  async function handleDelete(node: FsNode) {
    setCtx(null)
    const api = window.electronAPI
    if (!api) return
    await api.fsDelete(root, node.rel)
    loadDir(parentOf(node.rel))
  }

  async function handleDuplicate(node: FsNode) {
    setCtx(null)
    const api = window.electronAPI
    if (!api) return
    const result = await api.fsCopyFile(root, node.rel)
    loadDir(parentOf(node.rel))
    if (result.rel) onSelect(result.rel)
  }

  function handleCopyPath(node: FsNode) {
    setCtx(null)
    navigator.clipboard.writeText(`${root}/${node.rel}`).catch(() => {})
  }

  function handleCopy(node: FsNode) {
    setCtx(null)
    setClipboard({ rel: node.rel, kind: node.kind, mode: 'copy' })
  }

  function handleCut(node: FsNode) {
    setCtx(null)
    setClipboard({ rel: node.rel, kind: node.kind, mode: 'cut' })
  }

  async function handlePaste(destDirRel: string) {
    setCtx(null)
    const clip = clipboard
    const api = window.electronAPI
    if (!api || !clip || !canPasteInto(clip, destDirRel)) return
    if (clip.mode === 'cut') {
      const result = await api.fsMove(root, clip.rel, destDirRel)
      loadDir(parentOf(clip.rel))
      loadDir(destDirRel)
      if (!result.rel) return
      setClipboard(null)
      if (clip.kind === 'file' && activeRel === clip.rel) onSelect(result.rel)
      return
    }
    const result = await api.fsCopyFile(root, clip.rel, destDirRel)
    loadDir(destDirRel)
    if (clip.kind === 'file' && result.rel) onSelect(result.rel)
  }

  // ── Drag-and-drop ────────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, node: FsNode) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', node.rel)
    setDragSrc(node)
  }

  function onDragEnd() {
    setDragSrc(null)
    setDropTarget(null)
  }

  function canDrop(src: FsNode, destDirRel: string): boolean {
    if (parentOf(src.rel) === destDirRel) return false        // already there
    if (src.kind === 'dir' && isAncestorOf(src.rel, destDirRel)) return false  // can't drop into self/child
    return true
  }

  function onDirDragOver(e: React.DragEvent, dirRel: string) {
    if (!dragSrc || !canDrop(dragSrc, dirRel)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== dirRel) setDropTarget(dirRel)
  }

  function onDirDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropTarget(null)
    }
  }

  async function onDirDrop(e: React.DragEvent, destDirRel: string) {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const src = dragSrc
    setDragSrc(null)
    if (!src || !canDrop(src, destDirRel)) return
    const api = window.electronAPI
    if (!api) return
    const result = await api.fsMove(root, src.rel, destDirRel)
    loadDir(parentOf(src.rel))
    loadDir(destDirRel)
    if (result.rel && src.kind === 'file' && activeRel === src.rel) onSelect(result.rel)
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function renderNode(node: FsNode, depth: number): React.ReactNode {
    const isDir      = node.kind === 'dir'
    if (!isDir && fileFilter && !fileFilter(node.name)) return null
    const state      = cache[node.rel]
    const open       = isDir && !!state?.open
    const isActive   = selectedRel === node.rel || (!isDir && activeRel === node.rel)
    const isRenaming = renameRel === node.rel
    const isDragging = dragSrc?.rel === node.rel
    const isCut      = clipboard?.mode === 'cut' && clipboard.rel === node.rel
    const isDropZone = isDir && dropTarget === node.rel

    return (
      <div key={node.path}>
        <div
          className={[
            'ft-row',
            isDir ? 'dir' : 'file',
            isActive   ? 'on'        : '',
            isDragging ? 'ft-drag-ghost' : '',
            isCut      ? 'ft-cut'        : '',
            isDropZone ? 'ft-drop-target' : '',
          ].filter(Boolean).join(' ')}
          style={{ paddingLeft: 6 + depth * 12 }}
          draggable
          onClick={() => { if (!isRenaming) toggle(node.rel, isDir) }}
          onContextMenu={e => openCtx(e, node, isDir)}
          onDragStart={e => { e.stopPropagation(); onDragStart(e, node) }}
          onDragEnd={onDragEnd}
          onDragOver={isDir ? e => onDirDragOver(e, node.rel) : undefined}
          onDragLeave={isDir ? onDirDragLeave : undefined}
          onDrop={isDir ? e => onDirDrop(e, node.rel) : undefined}
        >
          <span className="ft-row-content">
            <span className="ft-chev">{isDir ? (open ? '∨' : '>') : ''}</span>
            <BeardedFileIcon name={node.name} directory={isDir} open={open} size={15} />
            {isRenaming ? (
              <input
                ref={renameInputRef}
                className="ft-new-input"
                value={renameName}
                onChange={e => setRenameName(e.target.value)}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') cancelRename()
                }}
                onBlur={cancelRename}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="ft-name">{node.name}</span>
            )}
            {isDir && open && !isRenaming && (
              <span
                className="ft-new-btn"
                title="new file"
                onClick={e => { e.stopPropagation(); startNew('file', node.rel) }}
              >+</span>
            )}
          </span>
        </div>

        {isDir && open && state && (
          <>
            {state.loading && (
              <div className="ft-row" style={{ paddingLeft: 6 + (depth + 1) * 12, opacity: 0.5 }}>loading…</div>
            )}
            {state.error && (
              <div className="ft-row" style={{ paddingLeft: 6 + (depth + 1) * 12, color: 'var(--err, #e06464)' }}>
                {state.error}
              </div>
            )}
            {newKind && newParent === node.rel && (
              <div className="ft-row ft-new-row" style={{ paddingLeft: 6 + (depth + 1) * 12 }}>
                <span className="ft-chev" />
                <BeardedFileIcon name={newName || 'untitled'} directory={newKind === 'folder'} open={false} size={15} />
                <input
                  ref={newInputRef}
                  className="ft-new-input"
                  value={newName}
                  placeholder={newKind === 'folder' ? 'folder name' : 'file name'}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Enter') commitNew()
                    if (e.key === 'Escape') cancelNew()
                  }}
                  onBlur={cancelNew}
                />
              </div>
            )}
            {state.children.map(child => renderNode(child, depth + 1))}
          </>
        )}
      </div>
    )
  }

  const rootEntries = cache['']?.children ?? []

  return (
    <div className="ft" style={width !== undefined ? { width } : undefined}>
      <div className="ft-icons">
        <button className={panel === 'files'   ? 'on' : ''} onClick={() => setPanel('files')}   title="files">
          <Icon name="projects" size={14} />
        </button>
        <button className={panel === 'outline' ? 'on' : ''} onClick={() => setPanel('outline')} title="outline">
          <Icon name="sliders" size={14} />
        </button>
        <button className={panel === 'search'  ? 'on' : ''} onClick={() => setPanel('search')}  title="search">
          <Icon name="search" size={14} />
        </button>
      </div>

      {panel === 'files' && (
        <>
          <div
            className={`ft-tree${dropTarget === '' ? ' ft-drop-target-root' : ''}`}
            onContextMenu={e => { e.preventDefault(); openCtx(e, null, true) }}
            onDragOver={e => {
              if (!dragSrc || !canDrop(dragSrc, '')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dropTarget !== '') setDropTarget('')
            }}
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null)
            }}
            onDrop={e => onDirDrop(e, '')}
          >
            {!root && <div className="ft-row" style={{ opacity: 0.5 }}>no workspace selected</div>}
            {rootErr && <div className="ft-row" style={{ color: 'var(--err, #e06464)' }}>{rootErr}</div>}
            {newKind && newParent === '' && (
              <div className="ft-row ft-new-row" style={{ paddingLeft: 6 }}>
                <span className="ft-chev" />
                <BeardedFileIcon name={newName || 'untitled'} directory={newKind === 'folder'} open={false} size={15} />
                <input
                  ref={newInputRef}
                  className="ft-new-input"
                  value={newName}
                  placeholder={newKind === 'folder' ? 'folder name' : 'file name'}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Enter') commitNew()
                    if (e.key === 'Escape') cancelNew()
                  }}
                  onBlur={cancelNew}
                />
              </div>
            )}
            {rootEntries.map(node => renderNode(node, 0))}
          </div>
          <div className="ft-foot">
            <button className="ft-foot-btn" title="new file" onClick={() => startNew('file', '')}>
              <Icon name="code" size={13} />
            </button>
            <button className="ft-foot-btn" title="new folder" onClick={() => startNew('folder', '')}>
              <Icon name="projects" size={13} />
            </button>
          </div>
        </>
      )}

      {panel === 'outline' && (
        <div className="ft-tree ft-outline">
          {outlineFileName && <div className="ft-outline-file" title={outlineFileName}>{outlineFileName}</div>}
          {!outlineFileName && <div className="ft-outline-empty">open a file to view its symbols</div>}
          {outlineFileName && outlineSymbols.length === 0 && (
            <div className="ft-outline-empty">no symbols found</div>
          )}
          {outlineSymbols.map(symbol => (
            <button
              type="button"
              key={symbol.id}
              className="ft-outline-row"
              style={{ paddingLeft: 10 + Math.min(symbol.depth, 8) * 12 }}
              title={`${symbol.kind} · line ${symbol.line}`}
              onClick={() => onSelectOutline?.(symbol)}
            >
              <span className={`ft-outline-kind kind-${symbol.kind}`}>{symbol.kind.slice(0, 1).toUpperCase()}</span>
              <span className="ft-outline-name">{symbol.name}</span>
              <span className="ft-outline-line">{symbol.line}</span>
            </button>
          ))}
        </div>
      )}

      {panel === 'search' && (
        <div className="ft-tree">
          <div className="ft-search-bar">
            <div className="ft-search-input-wrap">
              <Icon name="search" size={12} />
              <input
                className="ft-search-input"
                placeholder="search files…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                spellCheck={false}
              />
            </div>
            <button
              className={`ft-search-case ${searchCase ? 'on' : ''}`}
              title="case sensitive"
              onClick={() => setSearchCase(c => !c)}
            >Aa</button>
          </div>
          <div className="ft-search-replace">
            <span className="ft-search-replace-label">Replace</span>
            <input
              className="ft-search-input"
              placeholder="replace with…"
              value={replaceText}
              onChange={event => setReplaceText(event.target.value)}
              spellCheck={false}
            />
            <button type="button" disabled={replaceBusy || searchResults.length === 0} onClick={() => void applyReplacement()}>
              {replaceBusy ? 'applying…' : `Replace all (${searchResults.length})`}
            </button>
          </div>
          <div className="ft-search-scope">
            <button
              className={searchScope === 'all' ? 'on' : ''}
              onClick={() => setSearchScope('all')}
              title="search all files"
            >all</button>
            <button
              className={searchScope === 'selected' ? 'on' : ''}
              onClick={() => setSearchScope('selected')}
              title="search open tabs only"
            >selected</button>
          </div>
          {searchLoading && (
            <div className="ft-row" style={{ opacity: 0.5, padding: '8px 12px' }}>searching…</div>
          )}
          {searchError && (
            <div className="ft-row" style={{ color: 'var(--err, #e06464)', padding: '8px 12px' }}>{searchError}</div>
          )}
          {!searchLoading && !searchError && searchResults.length === 0 && searchQuery.trim() && (
            <div className="ft-row" style={{ opacity: 0.5, padding: '8px 12px' }}>no results</div>
          )}
          {!searchQuery.trim() && (
            <div className="ft-row" style={{ opacity: 0.5, padding: '8px 12px' }}>type to search across files</div>
          )}
          <div className="ft-search-results">
            {searchResults.map((res, idx) => (
              <button
                key={`${res.rel}:${res.line}:${idx}`}
                className="ft-search-result"
                onClick={() => onSelectLine?.(res.rel, res.line, searchQuery, searchCase)}
              >
                <span className="ft-search-result-name">{res.name}</span>
                <span className="ft-search-result-text">{res.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {ctx && (
        <div ref={ctxRef} className="ft-ctx" style={{ left: ctx.x, top: ctx.y }}>
          {(ctx.isDir || ctx.node === null) && (
            <>
              <button className="ft-ctx-item" onClick={() => startNew('file', ctx.node?.rel ?? '')}>
                <FilePlusIcon weight="duotone" size={13} /> new file
              </button>
              <button className="ft-ctx-item" onClick={() => startNew('folder', ctx.node?.rel ?? '')}>
                <FolderPlusIcon weight="duotone" size={13} /> new folder
              </button>
              <div className="ft-ctx-sep" />
            </>
          )}
          {ctx.node && (
            <>
              <button className="ft-ctx-item" onClick={() => handleCut(ctx.node!)}>
                <ScissorsIcon weight="duotone" size={13} /> cut
              </button>
              <button className="ft-ctx-item" onClick={() => handleCopy(ctx.node!)}>
                <CopyIcon weight="duotone" size={13} /> copy
              </button>
            </>
          )}
          <button
            className="ft-ctx-item"
            disabled={!clipboard || !canPasteInto(clipboard, pasteTargetDirRel(ctx.node, ctx.isDir))}
            onClick={() => handlePaste(pasteTargetDirRel(ctx.node, ctx.isDir))}
          >
            <ClipboardIcon weight="duotone" size={13} /> paste
          </button>
          {ctx.node && !ctx.isDir && (
            <button className="ft-ctx-item" onClick={() => handleDuplicate(ctx.node!)}>
              <CopyIcon weight="duotone" size={13} /> duplicate
            </button>
          )}
          {ctx.node && (
            <>
              <button className="ft-ctx-item" onClick={() => handleCopyPath(ctx.node!)}>
                <ClipboardTextIcon weight="duotone" size={13} /> copy path
              </button>
              <button className="ft-ctx-item" onClick={() => startRename(ctx.node!)}>
                <PencilIcon weight="duotone" size={13} /> rename
              </button>
              <div className="ft-ctx-sep" />
              <button className="ft-ctx-item danger" onClick={() => handleDelete(ctx.node!)}>
                <TrashIcon weight="duotone" size={13} /> delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
