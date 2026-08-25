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
      className="chip-mono wl-file-link inline-flex min-w-0 max-w-full cursor-pointer appearance-none items-center truncate rounded-md border border-cc-line bg-cc-field px-1.5 py-0.5 font-mono text-[11px] text-cc-ink transition-colors hover:bg-cc-hover"
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
    return <span className="wl-row-text wl-pending min-w-0 truncate text-[12px] text-cc-muted">{row.pendingText ?? `${row.label}...`}</span>
  }
  // File-touching rows: verb chip + clickable filename + +N -M stats.
  if (row.filename && (row.kind === 'edit' || row.kind === 'write' || row.kind === 'read')) {
    const verb = row.verb ?? (row.kind === 'edit' ? 'Modified' : row.kind === 'write' ? 'Coding' : 'Read')
    return (
      <span className="wl-row-text wl-row-file min-w-0 text-[12px]">
        <span className="wl-verb shrink-0 text-cc-muted">{verb}</span>
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
      <span className="wl-row-text wl-row-file min-w-0 text-[12px]">
        <span className="wl-verb shrink-0 text-cc-muted">{row.verb}</span>
        <code>{row.title}</code>
      </span>
    )
  }
  if (row.title) {
    return <span className="wl-row-text min-w-0 truncate text-[12px]"><code>{row.title}</code></span>
  }
  return (
    <span className="wl-row-text min-w-0 truncate text-[12px] text-cc-muted">
      {row.label}{row.body ? <> — <code>{row.body}</code></> : null}
    </span>
  )
}

export function TurnWorkLog({ rows, live, total, onOpenFile }: TurnWorkLogProps) {
  // Keep the consolidated turn summary visible when it lands immediately before
  // the final response; users can still collapse it from the header.
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<Record<number, boolean>>(() => {
    // TodoWrite is a primary progress surface, so show it immediately in chat.
    return Object.fromEntries(rows.map((row, i) => [i, row.kind === 'todowrite']))
  })

  const count = total ?? rows.length
  const hasError = rows.some(row => row.status === 'error' || row.kind === 'error')

  return (
    <div className="wl wl-compact">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="-mx-1.5 flex max-w-[calc(100%+0.75rem)] cursor-pointer appearance-none items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left font-mono text-[12px] text-cc-muted transition-colors duration-150 hover:bg-cc-hover hover:text-cc-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-cc-accent sm:text-[12.5px]"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 transition-transform duration-200"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="truncate tabular-nums">
          {count} tool {count === 1 ? 'call' : 'calls'}
        </span>
        {live && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-cc-muted">
            <span className="size-1.5 rounded-full bg-cc-success [animation:wl-pulse_1.2s_ease-in-out_infinite]" />
            live
          </span>
        )}
        {hasError && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-cc-danger">
            <span className="size-1.5 rounded-full bg-cc-danger" />
            error
          </span>
        )}
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1.5 flex min-w-0 flex-col gap-1 pb-1">
            {rows.map((row, i) => {
              const isErr = row.status === 'error' || row.kind === 'error'
              const canExpand = hasExpandableBody(row)
              const showBody = expanded[i] && canExpand
              const status: WorkLogRowStatus = row.status ?? 'done'
              const hasInlineDiagnostics = (row.diagnostics?.length ?? 0) > 0

              return (
                <div
                  key={i}
                  className="min-w-0 [animation:cc-fade-up_240ms_cubic-bezier(0.23,1,0.32,1)_both]"
                >
                  <div
                    role={canExpand ? 'button' : undefined}
                    tabIndex={canExpand ? 0 : undefined}
                    aria-expanded={canExpand ? showBody : undefined}
                    onClick={() => canExpand && setExpanded(current => ({ ...current, [i]: !current[i] }))}
                    onKeyDown={(event) => {
                      if (event.currentTarget !== event.target || !canExpand || (event.key !== 'Enter' && event.key !== ' ')) return
                      event.preventDefault()
                      setExpanded(current => ({ ...current, [i]: !current[i] }))
                    }}
                    className={`group -mx-[3px] flex min-h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-md px-[3px] py-1 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-cc-accent ${canExpand ? 'cursor-pointer hover:bg-cc-hover' : ''} ${isErr ? 'text-cc-danger' : ''}`}
                  >
                    <span className="relative flex size-4 shrink-0 items-center justify-center text-cc-muted">
                      <span className={`transition-opacity duration-150 ${canExpand ? 'group-hover:opacity-0' : ''} ${showBody ? 'opacity-0' : ''}`}>
                        <Icon name={rowIconName(row.kind)} size={13} />
                      </span>
                      {canExpand && (
                        <span
                          className={`absolute inline-flex transition-[opacity,transform] duration-150 group-hover:opacity-100 ${showBody ? 'opacity-100' : 'opacity-0'}`}
                          style={{ transform: showBody ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                        >
                          <Icon name="chevDown" size={12} />
                        </span>
                      )}
                    </span>
                    <RowTitle row={row} onOpenFile={onOpenFile} />
                    <span
                      className={`wl-row-status wl-row-status-${status}`}
                      role="img"
                      aria-label={status}
                      title={status}
                    >
                      <Icon name={STATUS_ICON[status]} size={12} />
                    </span>
                  </div>

                  {hasInlineDiagnostics && <DiagnosticsList items={row.diagnostics!} />}
                  {showBody && (
                    <div className="ml-2 min-w-0 border-l border-cc-line py-1 pl-3 sm:ml-2.5 sm:pl-3.5">
                      <RowBody row={row} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
