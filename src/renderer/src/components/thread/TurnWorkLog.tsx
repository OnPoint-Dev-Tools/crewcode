import React, { useState } from 'react'
import { Icon, IconName } from '../ui/Icon'
import { PierreDiff } from '../diff/PierreDiff'
import { CodeBlock } from '../code/CodeBlock'

export type WorkLogRowKind =
  | 'cmd' | 'file' | 'tool' | 'search' | 'reason' | 'warn' | 'error'
  | 'read' | 'edit' | 'write' | 'bash' | 'webfetch'
  | 'todowrite' | 'task' | 'glob' | 'grep' | 'list' | 'patch'

export type WorkLogRowStatus = 'pending' | 'running' | 'done' | 'error'

const STATUS_ICON: Record<WorkLogRowStatus, IconName> = {
  pending: 'pause',
  running: 'hourglass',
  done:    'check',
  error:   'x',
}

export interface TodoItem {
  status:      'pending' | 'in_progress' | 'completed' | 'cancelled'
  text:        string
  activeForm?: string
}

export interface TaskSummaryItem {
  tool: string
  text: string
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface Diagnostic {
  severity: DiagnosticSeverity
  message:  string
  line?:    number
  column?:  number
  source?:  string
}

export interface WorkLogRow {
  kind:    WorkLogRowKind
  title?:  string
  label:   string
  body:    string
  detail?: string
  status?: WorkLogRowStatus
  pendingText?: string
  preview?:     string
  diff?:        string
  content?:     string
  output?:      string
  fetched?:     string
  todos?:       TodoItem[]
  taskSummary?: TaskSummaryItem[]
  filename?:    string
  /** Absolute or workspace-relative path — used for click-to-open. */
  filePath?:    string
  added?:       number
  removed?:     number
  verb?:        string
  /** Shiki language id for highlighted code blocks (bash/read/write). */
  lang?:        string
  /** Inline LSP errors/warnings to surface under the row. */
  diagnostics?: Diagnostic[]
}

interface TurnWorkLogProps {
  rows:    WorkLogRow[]
  live:    boolean
  total?:  number
  /** Click handler for filenames in the row title. */
  onOpenFile?: (path: string) => void
}

function rowIconName(kind: WorkLogRowKind): IconName {
  switch (kind) {
    case 'cmd':
    case 'bash':       return 'terminal'
    case 'file':       return 'fileText'
    case 'read':       return 'fileCode'
    case 'edit':       return 'fileEdit'
    case 'write':      return 'filePlus'
    case 'webfetch':   return 'globe'
    case 'todowrite':  return 'listChecks'
    case 'task':       return 'listTree'
    case 'glob':
    case 'grep':
    case 'search':     return 'search'
    case 'list':       return 'folder'
    case 'patch':      return 'fileEdit'
    case 'reason':     return 'brain'
    case 'warn':       return 'check'
    case 'error':      return 'bell'
    case 'tool':       return 'wrench'
  }
}

function iconForToolName(tool: string): IconName {
  const t = tool.toLowerCase()
  if (t === 'bash' || t === 'shell')   return 'terminal'
  if (t === 'read')                    return 'fileCode'
  if (t === 'edit' || t === 'patch')   return 'fileEdit'
  if (t === 'write')                   return 'filePlus'
  if (t === 'webfetch')                return 'globe'
  if (t === 'glob' || t === 'grep')    return 'search'
  if (t === 'list')                    return 'folder'
  if (t === 'todowrite')               return 'listChecks'
  if (t === 'task')                    return 'listTree'
  return 'wrench'
}

function DiagnosticsList({ items }: { items: Diagnostic[] }) {
  if (!items.length) return null
  return (
    <div className="wl-diagnostics">
      {items.map((d, i) => (
        <div key={i} className={`wl-diag wl-diag-${d.severity}`}>
          <span className={`wl-diag-pill wl-diag-pill-${d.severity}`}>{d.severity}</span>
          {d.line !== undefined && (
            <span className="wl-diag-loc">L{d.line}{d.column !== undefined ? `:${d.column}` : ''}</span>
          )}
          <span className="wl-diag-msg">{d.message}</span>
          {d.source && <span className="wl-diag-source">{d.source}</span>}
        </div>
      ))}
    </div>
  )
}

const LIVE_OUTPUT_MAX_CHARS = 12_000

function livePlainCode(code: string): React.ReactElement {
  const clipped = code.length > LIVE_OUTPUT_MAX_CHARS
    ? `${code.slice(-LIVE_OUTPUT_MAX_CHARS)}\n… live output clipped; full output renders after completion`
    : code
  return <pre className="shiki-block-fallback">{clipped}</pre>
}

function RowBody({ row }: { row: WorkLogRow }) {
  const live = row.status === 'running' || row.status === 'pending'
  // bash: avoid Shiki while live; command output can update many times/sec.
  if ((row.kind === 'bash' || row.kind === 'cmd') && (row.output || row.body)) {
    const code = (row.body ? `$ ${row.body}\n` : '') + (row.output ?? '')
    return (
      <div className="wl-codeblock">
        {live ? livePlainCode(code) : <CodeBlock code={code} lang={row.lang ?? 'bash'} />}
      </div>
    )
  }
  if (row.kind === 'todowrite' && row.todos && row.todos.length > 0) {
    return (
      <div className="wl-todos">
        {row.todos.map((t, i) => <div key={i} className={`wl-todo ${t.status === 'completed' ? 'done' : t.status === 'cancelled' ? 'cancelled' : t.status === 'in_progress' ? 'active' : ''}`}>- [{t.status === 'completed' ? 'x' : ' '}] {t.text}</div>)}
      </div>
    )
  }
  if (row.kind === 'task' && row.taskSummary && row.taskSummary.length > 0) {
    return (
      <div className="wl-task-summary">
        {row.taskSummary.map((t, i) => (
          <div key={i} className="wl-task-row">
            <Icon name={iconForToolName(t.tool)} size={12} />
            <span className="chip-mono">{t.tool}</span>
            <span className="wl-task-text">{t.text}</span>
          </div>
        ))}
      </div>
    )
  }
  // edit: render with PierreDiff inside a scrolling container.
  if (row.kind === 'edit' && row.diff) {
    return (
      <div className="wl-pierre">
        <PierreDiff patch={row.diff} />
      </div>
    )
  }
  // read: syntax-highlighted preview keyed off the filename's language.
  if (row.kind === 'read' && row.preview) {
    return (
      <div className="wl-codeblock">
        {live ? livePlainCode(row.preview) : <CodeBlock code={row.preview} lang={row.lang ?? 'text'} />}
      </div>
    )
  }
  // write: syntax-highlighted full content after completion only.
  if (row.kind === 'write' && row.content) {
    return (
      <div className="wl-codeblock">
        {live ? livePlainCode(row.content) : <CodeBlock code={row.content} lang={row.lang ?? 'text'} />}
      </div>
    )
  }
  if (row.kind === 'webfetch' && row.fetched) {
    return <pre className="wl-detail-pre">{row.fetched}</pre>
  }
  if (row.detail) {
    const isErr = row.status === 'error' || row.kind === 'error'
    return <pre className={`wl-detail-pre ${isErr ? 'err' : ''}`}>{row.detail}</pre>
  }
  return null
}

function hasExpandableBody(row: WorkLogRow): boolean {
  return Boolean(
    row.detail || row.preview || row.diff || row.content || row.output ||
    row.fetched || (row.todos && row.todos.length > 0) ||
    (row.taskSummary && row.taskSummary.length > 0) ||
    (row.diagnostics && row.diagnostics.length > 0)
  )
}

interface FilenameProps {
  name:     string
  path?:    string
  onOpen?:  (path: string) => void
}
function Filename({ name, path, onOpen }: FilenameProps) {
  const clickable = Boolean(path && onOpen)
  if (!clickable) return <span className="chip-mono">{name}</span>
  return (
    <button
      type="button"
      className="chip-mono wl-file-link"
      onClick={(e) => { e.stopPropagation(); onOpen!(path!) }}
      title={`Open ${path}`}
    >
      {name}
    </button>
  )
}

interface RowTitleProps {
  row:        WorkLogRow
  onOpenFile?: (path: string) => void
}
function RowTitle({ row, onOpenFile }: RowTitleProps): React.ReactElement {
  if (row.status === 'pending') {
    return <span className="wl-row-text wl-pending">{row.pendingText ?? `${row.label}...`}</span>
  }
  // File-touching rows: verb chip + clickable filename + +N -M stats.
  if (row.filename && (row.kind === 'edit' || row.kind === 'write' || row.kind === 'read')) {
    const verb = row.verb ?? (row.kind === 'edit' ? 'Modified' : row.kind === 'write' ? 'Coding' : 'Read')
    return (
      <span className="wl-row-text wl-row-file">
        <span className="wl-verb">{verb}</span>
        <Filename name={row.filename} path={row.filePath} onOpen={onOpenFile} />
        {(row.added !== undefined || row.removed !== undefined) && (
          <span className="wl-diff-stats">
            {row.added   !== undefined && row.added   > 0 && <span className="wl-add">+{row.added}</span>}
            {row.removed !== undefined && row.removed > 0 && <span className="wl-del">-{row.removed}</span>}
          </span>
        )}
      </span>
    )
  }
  if (row.verb && row.title) {
    return (
      <span className="wl-row-text wl-row-file">
        <span className="wl-verb">{row.verb}</span>
        <code>{row.title}</code>
      </span>
    )
  }
  if (row.title) {
    return <span className="wl-row-text"><code>{row.title}</code></span>
  }
  return (
    <span className="wl-row-text">
      {row.label}{row.body ? <> — <code>{row.body}</code></> : null}
    </span>
  )
}

export function TurnWorkLog({ rows, live, total, onOpenFile }: TurnWorkLogProps) {
  const [open, setOpen] = useState(live)
  const [expanded, setExpanded] = useState<Record<number, boolean>>(() => {
    // TodoWrite is a primary progress surface, so show it immediately in chat.
    return Object.fromEntries(rows.map((row, i) => [i, row.kind === 'todowrite']))
  })

  const count    = total ?? rows.length
  const hasError = rows.some(r => r.status === 'error' || r.kind === 'error')

  return (
    <div className="wl wl-compact">
      <div className="wl-h" onClick={() => setOpen(o => !o)}>
        <div className="wl-icon">&gt;_</div>
        <div className="wl-meta">
          <div className="wl-t">work log ({count})</div>
          <div className="wl-sub">
            <span><span className={`dot ${live ? 'live' : ''}`} /> {live ? 'live' : 'idle'}</span>
            {hasError && <span><span className="dot err" /> error</span>}
          </div>
        </div>
        <div className="wl-chev" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <Icon name="chevDown" size={12} />
        </div>
      </div>
      {open && (
        <div className="wl-body">
          {rows.map((row, i) => {
            const isErr     = row.status === 'error' || row.kind === 'error'
            const canExpand = hasExpandableBody(row)
            const showBody  = expanded[i] && canExpand
            const status: WorkLogRowStatus = row.status ?? 'done'
            const hasInlineDiagnostics = (row.diagnostics?.length ?? 0) > 0
            return (
              <div key={i} className={`wl-call wl-call-${status}`}>
                <div
                  className={`wl-row ${canExpand ? 'wl-row-clickable' : ''} ${isErr ? 'wl-row-fail' : ''}`}
                  onClick={() => canExpand && setExpanded(e => ({ ...e, [i]: !e[i] }))}
                >
                  <span className="wl-row-mark">
                    <Icon name={rowIconName(row.kind)} size={12} />
                  </span>
                  <RowTitle row={row} onOpenFile={onOpenFile} />
                  <span className={`wl-row-status wl-row-status-${status}`}>
                    <Icon name={STATUS_ICON[status]} size={12} />
                  </span>
                </div>
                {hasInlineDiagnostics && (
                  <DiagnosticsList items={row.diagnostics!} />
                )}
                {showBody && (
                  <div className="wl-detail">
                    <RowBody row={row} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
