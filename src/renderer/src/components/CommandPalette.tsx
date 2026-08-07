import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Icon } from './ui/Icon'
import { COMMAND_GROUPS } from '../data/commands'
import type { Command } from '../types'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onCommand: (cmd: Command) => void
  /** Active workspace path used to look up file matches. Optional — when
      missing the palette behaves as before (commands only). */
  workspaceRoot?: string
  /** Open a workspace-relative file in the appropriate editor. */
  onOpenFile?: (rel: string) => void
  extraCommands?: Command[]
}

interface FileItem {
  rel:   string
  base:  string
}

function basename(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i === -1 ? rel : rel.slice(i + 1)
}

function scoreMatch(rel: string, base: string, q: string): number {
  // Small fuzzy ranker: prefer basename hits, then prefix hits, then any substring.
  const r = rel.toLowerCase(); const b = base.toLowerCase(); const ql = q.toLowerCase()
  if (b === ql)            return 1000
  if (b.startsWith(ql))    return 800
  if (b.includes(ql))      return 600
  if (r.includes('/' + ql))return 400
  if (r.includes(ql))      return 200
  return 0
}

export function CommandPalette({ open, onClose, onCommand, workspaceRoot, onOpenFile, extraCommands = [] }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [files, setFiles] = useState<FileItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  // Cache the workspace file list while the palette is open. Refetch when the
  // workspace changes so renames/adds show up on the next open.
  useEffect(() => {
    if (!open || !workspaceRoot) { setFiles([]); return }
    let cancelled = false
    const api = window.electronAPI
    if (!api) return
    api.fsListFiles(workspaceRoot).then(res => {
      if (cancelled) return
      const list = (res.files ?? []).map(rel => ({ rel, base: basename(rel) }))
      setFiles(list)
    })
    return () => { cancelled = true }
  }, [open, workspaceRoot])

  const cmds = useMemo<Command[]>(() => {
    const items: Command[] = [
      ...COMMAND_GROUPS.flatMap(g => g.items.map(it => ({ ...it, group: g.group }))),
      ...extraCommands,
    ]
    if (!query) return items
    return items.filter(it =>
      `${it.label} ${it.hint}`.toLowerCase().includes(query.toLowerCase())
    )
  }, [query, extraCommands])

  const fileMatches = useMemo<FileItem[]>(() => {
    if (!query || files.length === 0) return []
    const ranked = files
      .map(f => ({ f, s: scoreMatch(f.rel, f.base, query) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 25)
    return ranked.map(x => x.f)
  }, [query, files])

  // Flat ordering — commands first, then files — so arrow keys move through both.
  const flat = useMemo(() => {
    const cmdRows = cmds.map(c => ({ kind: 'cmd' as const, cmd: c }))
    const fileRows = fileMatches.map(f => ({ kind: 'file' as const, file: f }))
    return [...cmdRows, ...fileRows]
  }, [cmds, fileMatches])

  const grouped = useMemo(() => {
    const m: Record<string, Command[]> = {}
    cmds.forEach(it => { (m[it.group] ??= []).push(it) })
    return m
  }, [cmds])

  const runRow = (i: number): void => {
    const row = flat[i]
    if (!row) return
    if (row.kind === 'cmd') { onCommand(row.cmd); onClose(); return }
    if (row.kind === 'file' && onOpenFile) { onOpenFile(row.file.rel); onClose(); return }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape')    { e.preventDefault(); onClose() }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, flat.length - 1)) }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
      if (e.key === 'Enter')     { e.preventDefault(); runRow(cursor) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flat, cursor, onClose, onCommand, onOpenFile])

  if (!open) return null

  let idx = -1
  return (
    <div className="cp-backdrop" onClick={onClose}>
      <div className="cp" onClick={e => e.stopPropagation()}>
        <div className="cp-input">
          <Icon name="sparkle" size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setCursor(0) }}
            placeholder="search commands, workspaces, files..."
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cp-list">
          {Object.entries(grouped).map(([group, items]) => (
            <React.Fragment key={group}>
              <div className="cp-sec">{group.toUpperCase()}</div>
              {items.map(it => {
                idx++
                const on = idx === cursor
                const myIdx = idx
                return (
                  <div
                    key={it.id}
                    className={`cp-row ${on ? 'on' : ''}`}
                    onMouseEnter={() => setCursor(myIdx)}
                    onClick={() => { onCommand(it); onClose() }}
                  >
                    <span className="ico"><Icon name={it.icon as any} size={13} /></span>
                    <span className="label">{it.label}</span>
                    {it.hint && <span className="hint">{it.hint}</span>}
                    {it.kbd  && <span className="kbd">{it.kbd}</span>}
                  </div>
                )
              })}
            </React.Fragment>
          ))}
          {fileMatches.length > 0 && (
            <>
              <div className="cp-sec">FILES</div>
              {fileMatches.map(f => {
                idx++
                const on = idx === cursor
                const myIdx = idx
                return (
                  <div
                    key={`f:${f.rel}`}
                    className={`cp-row ${on ? 'on' : ''}`}
                    onMouseEnter={() => setCursor(myIdx)}
                    onClick={() => { onOpenFile?.(f.rel); onClose() }}
                    title={f.rel}
                  >
                    <span className="ico"><Icon name="code" size={13} /></span>
                    <span className="label">{f.base}</span>
                    <span className="hint">{f.rel}</span>
                  </div>
                )
              })}
            </>
          )}
          {flat.length === 0 && (
            <div className="cp-row" style={{ color: 'var(--muted-foreground)' }}>
              no commands or files match "{query}"
            </div>
          )}
        </div>
        <div className="cp-foot">
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">↵</span> run</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  )
}
