import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizePatchForPierre, pathField, extractProviderPatchChanges, diffStats } from '../../hooks/turn-file-edit-detect'
import { TurnWorkLog } from './TurnWorkLog'
import type { WorkLogRow, WorkLogChangedFile, TodoItem, TaskSummaryItem, Diagnostic } from './TurnWorkLog'
import { ThinkingBlock } from './ThinkingBlock'
import { isCrewCoderTaskActivityTool, todosFromToolCall, todoItemFromUnknown } from './todo-from-toolcall'
import { changesForToolMessages } from './turn-changes-data'
import type { TurnChangeTarget } from './turn-changes-data'
import { LoadingBlock } from './LoadingBlock'
import { Markdown } from './Markdown'
import { Icon } from '../ui/Icon'
import { UserProfileAvatar } from '../profile/UserProfileAvatar'
import { AttachmentPreviewStrip } from '../attachments/AttachmentPreviewStrip'
import { useSettings } from '../../hooks/useSettings'
import {
  MAX_SELECTION_SPEECH_CHARS,
  playSelectionSpeech,
  stopSelectionSpeech,
  useSelectionSpeechState,
} from '../../voice/selection-speech-playback'
import type { ChatAttachment, Message, MessageBlock, ModeLevel, ToolCallMessage, TurnUsage } from '../../types'

function CodeChip({ children }: { children: React.ReactNode }) {
  return <span className="chip-mono">{children}</span>
}

interface UserBubbleProps {
  text: string
  time: string
  speaker?: string
  attachments?: ChatAttachment[]
  workspacePath?: string
}

function UserBubble({ text, time, speaker, attachments = [], workspacePath }: UserBubbleProps) {
  const { state } = useSettings()
  // A speaker tag marks a relayed worker turn — render it as an incoming,
  // left-aligned bubble with the worker's label rather than the local "you".
  if (speaker) {
    const initial = speaker.replace(/[^a-z0-9]/gi, '').charAt(0).toLowerCase() || '◆'
    return (
      <div className="bub-speaker">
        <div className="bub-speaker-head">
          <div className="avatar avatar-worker">{initial}</div>
          <span className="bub-speaker-name">{speaker}</span>
        </div>
        <div className="bub-incoming"><Markdown text={text} /></div>
        <div className="ts">{time}</div>
      </div>
    )
  }
  return (
    <div>
      <div className="bub-wrap">
        <div className="bub-user-stack">
          <div className="bub-user">
            <div className="bub-user-text">{text}</div>
            <CopyButton text={text} />
          </div>
          <AttachmentPreviewStrip attachments={attachments} workspacePath={workspacePath} variant="message" />
        </div>
        <UserProfileAvatar
          username={state.username}
          iconKind={state.profileIconKind}
          iconValue={state.profileIconValue}
          className="avatar"
        />
      </div>
      <div className="ts">{time}</div>
    </div>
  )
}

interface AgentBubbleProps {
  blocks:    MessageBlock[]
  text?:     string
  chunks?:   string[]
  time:      string
  streaming?: boolean
  durationMs?: number
  usage?:    TurnUsage
  mode?:     ModeLevel
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `Worked for ${minutes}m ${seconds}s`
  return `Worked for ${seconds}s`
}

// 14013 → "14,013". Compact form (14k) is reserved for the inline pill.
function withThousands(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

// 14013 → "14k", 1_047_576 → "1M". Keeps the inline strip narrow.
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

// Output tokens per second over the turn's wall-clock. Returns null when we
// can't compute it (no duration, no output count) so the strip hides cleanly.
function tokensPerSecond(usage: TurnUsage | undefined, durationMs: number | undefined): number | null {
  if (!usage || !durationMs || durationMs <= 0) return null
  const out = usage.outputTokens
  if (out === undefined || out <= 0) return null
  return out / (durationMs / 1000)
}

function contextPercent(usage: TurnUsage | undefined): number | null {
  if (!usage) return null
  if (usage.compaction?.percent !== undefined) return Math.min(100, usage.compaction.percent)
  if (!usage.contextWindow || !usage.contextTokens) return null
  return Math.min(100, (usage.contextTokens / usage.contextWindow) * 100)
}

/** Copy-to-clipboard affordance — flips to a check for a beat after copying. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const onCopy = () => {
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1400)
    }).catch(() => { /* clipboard denied — no-op */ })
  }

  return (
    <button
      type="button"
      className={`msg-copy ${copied ? 'copied' : ''}`}
      onClick={onCopy}
      title={copied ? 'copied' : 'copy message'}
      aria-label={copied ? 'copied' : 'copy message'}
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      <span>{copied ? 'copied' : 'copy'}</span>
    </button>
  )
}

/** Read an agent reply with the configured voice provider. */
function SpeechButton({ text }: { text: string }) {
  const { state: settings } = useSettings()
  const speech = useSelectionSpeechState()
  const [error, setError] = useState<string | null>(null)
  const active = speech.phase !== 'idle' && speech.text === text
  const loading = active && speech.phase === 'loading'
  const tooLong = text.length > MAX_SELECTION_SPEECH_CHARS
  const unavailable = settings.voiceProvider === 'off' || settings.voiceProvider === 'fake'

  if (unavailable) return null

  const onRead = () => {
    setError(null)
    if (active) {
      stopSelectionSpeech()
      return
    }
    const voice = settings.voiceProvider === 'openai'
      ? settings.voiceOpenAIVoice
      : settings.voiceProvider === 'xai'
        ? settings.voiceXaiVoice
        : settings.voiceLocalVoice
    void playSelectionSpeech({
      provider: settings.voiceProvider,
      text,
      voice,
      localPythonPath: settings.voiceLocalPythonPath,
      localDevice: settings.voiceLocalDevice,
      localSpeed: settings.voiceProvider === 'local' ? settings.voiceLocalSpeed : undefined,
    }).then(setError)
  }

  const label = tooLong
    ? `message exceeds the ${MAX_SELECTION_SPEECH_CHARS.toLocaleString('en-US')}-character speech limit`
    : error ?? (active ? 'stop reading message' : 'read message aloud')

  return (
    <button
      type="button"
      className={`msg-speech ${active ? 'active' : ''} ${error ? 'error' : ''}`}
      onClick={onRead}
      disabled={tooLong}
      title={label}
      aria-label={label}
    >
      {loading ? <span className="voice-orb-spinner" aria-hidden /> : <Icon name={active ? 'pause' : 'volume'} size={12} />}
      <span>{loading ? 'loading' : active ? 'stop' : 'listen'}</span>
    </button>
  )
}

/** Floating "Context Window" card — opened by clicking the context pill. */
function ContextWindowPopover({ usage, onClose }: { usage: TurnUsage; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const used   = usage.contextTokens ?? 0
  const total  = usage.contextWindow ?? 0
  const pct     = contextPercent(usage) ?? 0

  return (
    <div className="ctx-pop" ref={ref} role="dialog" aria-label="Context window usage">
      <div className="ctx-pop-title">Context Window</div>
      <div className="ctx-pop-headline">
        <span className="ctx-pop-used">{withThousands(used)}</span> used
        <span className="ctx-pop-total"> · {withThousands(total)} total</span>
      </div>
      <div className="ctx-pop-bar">
        <div className="ctx-pop-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <dl className="ctx-pop-rows">
        {usage.model && (
          <div className="ctx-pop-row">
            <dt>Model</dt><dd>{usage.model}</dd>
          </div>
        )}
        <div className="ctx-pop-row">
          <dt>Usage</dt><dd className="ctx-pop-pct">{pct.toFixed(1)}%</dd>
        </div>
        <div className="ctx-pop-row">
          <dt>Window</dt><dd>{withThousands(total)} tokens</dd>
        </div>
      </dl>
      {usage.contextBreakdown && usage.contextBreakdown.length > 0 && (
        <div className="ctx-pop-breakdown">
          <div className="ctx-pop-breakdown-title">What's using it</div>
          <dl className="ctx-pop-rows">
            {usage.contextBreakdown.map(cat => (
              <div className="ctx-pop-row" key={cat.name}>
                <dt>{cat.name}{cat.deferred ? ' (reserved)' : ''}</dt>
                <dd>{withThousands(cat.tokens)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

/** Inline tok/s + context strip rendered above the timestamp on agent bubbles. */
function UsageStrip({ usage, durationMs, copyText }: { usage?: TurnUsage; durationMs?: number; copyText: string }) {
  const [open, setOpen] = useState(false)
  const tps = tokensPerSecond(usage, durationMs)
  const pct = contextPercent(usage)

  return (
    <div className="usage-strip">
      {pct !== null && (
        <div className="usage-ctx-wrap">
          <button
            type="button"
            className="usage-cell usage-ctx-btn"
            onClick={() => setOpen(v => !v)}
            title="context / compaction usage — click for details"
            aria-expanded={open}
          >
            <span className="usage-ctx-dial" style={{ '--pct': `${pct}%` } as React.CSSProperties} />
            {usage?.compaction ? 'compact' : 'ctx'} {pct.toFixed(0)}%
          </button>
          {open && usage && <ContextWindowPopover usage={usage} onClose={() => setOpen(false)} />}
        </div>
      )}
      {tps !== null && (
        <span className="usage-cell" title="output tokens per second">
          <Icon name="bolt" size={11} />
          {compactTokens(tps)} tok/s
        </span>
      )}
      <CopyButton text={copyText} />
    </div>
  )
}

// Plain-text rendering of an agent reply for the copy button — the raw `text`
// when present, otherwise the concatenated block content.
function agentCopyText(text: string | undefined, blocks: MessageBlock[]): string {
  if (typeof text === 'string' && text !== '') return text
  return blocks.map(b => b[1]).join('')
}

type PlanView = 'markdown' | 'html'

function extractHtmlBody(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]
  return (body ?? html).trim()
}

function extractFencedHtml(text: string): string | null {
  const closed = text.match(/```(?:html|HTML)\s*\n([\s\S]*?)```/)
  if (closed?.[1]) return closed[1]

  // Some agents omit the closing fence. If we see an HTML fence, capture the
  // document through </html> so the preview still renders the page, not prose.
  const opened = text.match(/```(?:html|HTML)\s*\n([\s\S]*)$/)
  if (!opened?.[1]) return null
  const body = opened[1]
  const htmlEnd = body.search(/<\/html>/i)
  return htmlEnd >= 0 ? body.slice(0, htmlEnd + '</html>'.length) : body
}

function renderedPlanForPreview(text: string): string {
  const fencedHtml = extractFencedHtml(text)
  if (fencedHtml) return extractHtmlBody(fencedHtml)

  const raw = text.trim()
  if (/^<!doctype\s+html/i.test(raw) || /^<html[\s>]/i.test(raw) || /^<[a-z][\s\S]*>/i.test(raw)) {
    return extractHtmlBody(raw)
  }
  return renderToStaticMarkup(<Markdown text={text} />)
}

function buildHtmlPreview(text: string): string {
  const renderedPlan = renderedPlanForPreview(text)
  // The app owns the visual plan shell so agents only need to write Markdown.
  // Inline CSS keeps data-url previews self-contained inside the app browser.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CrewCode Plan</title>
</head>
<body style="margin:0;background:#0f120f;color:#d6dad6;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.58;">
  <main style="max-width:960px;margin:0 auto;padding:40px 28px 56px;">
    <section style="border:1px solid #1c2f2f;border-radius:18px;background:#121712;padding:24px;">
      <header style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #1c2f2f;padding-bottom:16px;margin-bottom:22px;">
        <div>
          <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7fa493;">CrewCode plan</div>
          <h1 style="margin:6px 0 0;color:#eef3ef;font-size:28px;line-height:1.15;letter-spacing:-.03em;">Implementation plan</h1>
        </div>
        <span style="border:1px solid #285a48;border-radius:999px;color:#a8d7c3;background:rgba(40,90,72,.22);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;padding:6px 10px;white-space:nowrap;">plan mode</span>
      </header>
      <article style="color:#d6dad6;font-size:15px;">
        <style>
          article h1, article h2, article h3, article h4 { color:#eef3ef; line-height:1.25; margin:1.1em 0 .45em; }
          article h1 { font-size:25px; } article h2 { font-size:21px; } article h3 { font-size:17px; }
          article p { margin:.45em 0 .8em; }
          article ul, article ol { padding-left:1.35em; margin:.45em 0 1em; }
          article li { margin:.28em 0; }
          article code { font-family:'JetBrains Mono',ui-monospace,monospace; font-size:.92em; background:#0f120f; border:1px solid #1c2f2f; border-radius:5px; padding:1px 5px; color:#f1f5f2; }
          article pre { background:#0f120f; border:1px solid #1c2f2f; border-radius:10px; padding:12px 14px; overflow:auto; }
          article pre code { border:0; padding:0; background:transparent; }
          article blockquote { margin:1em 0; padding:8px 12px; border-left:3px solid #285a48; color:#aeb9b0; background:rgba(40,90,72,.12); }
          article a { color:#8fd4b5; }
          article hr { border:0; border-top:1px solid #1c2f2f; margin:22px 0; }
          article table { border-collapse:collapse; width:100%; margin:1em 0; }
          article th, article td { border:1px solid #1c2f2f; padding:8px 10px; text-align:left; }
          article th { background:#182118; color:#eef3ef; }
        </style>
        ${renderedPlan}
      </article>
    </section>
  </main>
</body>
</html>`
}

function PlanFormatTabs({ value, onChange }: { value: PlanView; onChange: (v: PlanView) => void }) {
  const tabs: { id: PlanView; label: string }[] = [
    { id: 'markdown', label: 'markdown' },
    { id: 'html',     label: 'html' },
  ]
  return (
    <div className="plan-fmt-tabs" role="tablist" aria-label="plan format">
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className={`plan-fmt-tab ${value === t.id ? 'on' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function planHtmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function PlanBody({ text, onOpenLink }: { text: string; onOpenLink?: (url: string) => void }) {
  const [view, setView] = useState<PlanView>('markdown')
  const html = useMemo(() => buildHtmlPreview(text), [text])

  return (
    <div className={`plan-body plan-body-${view}`}>
      <div className="plan-toolbar">
        <PlanFormatTabs value={view} onChange={setView} />
        {view === 'html' && (
          <button
            type="button"
            className="plan-open-html"
            onClick={() => onOpenLink?.(planHtmlDataUrl(html))}
            disabled={!onOpenLink}
          >
            open html in app browser
          </button>
        )}
      </div>
      {view === 'markdown' && (
        <pre className="plan-md-source"><code>{text}</code></pre>
      )}
      {view === 'html' && (
        <iframe
          className="plan-html-frame"
          title="plan html preview"
          sandbox=""
          srcDoc={html}
        />
      )}
    </div>
  )
}

function StreamingText({ text, live = false }: { text: string; chunks?: string[]; live?: boolean }) {
  return (
    <div className={`stream-output min-w-0 whitespace-pre-wrap break-words text-cc-ink [overflow-wrap:anywhere]${live ? ' stream-output-live' : ''}`}>
      {/* Keep stream output as one text node; only the turn's final answer gets Markdown. */}
      {text || ' '}
    </div>
  )
}

function AgentBubble({ blocks, text, chunks, time, streaming, showStreamCursor = false, durationMs, usage, mode, showTurnSummary = true, onOpenLink }: AgentBubbleProps & { showStreamCursor?: boolean; showTurnSummary?: boolean; onOpenLink?: (url: string) => void }) {
  const canRenderMarkdown = showTurnSummary && !streaming
  const isPlan = canRenderMarkdown && mode === 'plan' && typeof text === 'string' && text !== ''
  const body = (text !== undefined && text !== '')
    ? streaming
      ? <StreamingText text={text} chunks={chunks} live />
      : canRenderMarkdown
        ? isPlan
          ? <PlanBody text={text} onOpenLink={onOpenLink} />
          : <Markdown text={text} onOpenLink={onOpenLink} />
        : <StreamingText text={text} chunks={chunks} />
      : blocks.map((block, i) =>
          block[0] === 't'
            ? <span key={i}>{block[1]}</span>
            : <CodeChip key={i}>{block[1]}</CodeChip>
        )

  return (
    <div className="agent-row">
      <div className="agent">
        <div className="body">
          {body}
          {streaming && showStreamCursor && <span className="stream-cursor" />}
        </div>
        {!streaming && (
          <UsageStrip
            usage={showTurnSummary ? usage : undefined}
            durationMs={durationMs}
            copyText={agentCopyText(text, blocks)}
          />
        )}
        <div className="ts">
          <span className="ts-time">{time}</span>
          {showTurnSummary && durationMs !== undefined && !streaming && (
            <span className="ts-duration">{formatDuration(durationMs)}</span>
          )}
          {!streaming && <SpeechButton text={agentCopyText(text, blocks)} />}
        </div>
      </div>
    </div>
  )
}

interface SystemNoticeProps { text: string; tone?: 'info' | 'error'; }
function SystemNotice({ text, tone }: SystemNoticeProps) {
  return (
    <div className={`system-notice ${tone ?? 'info'}`}>
      <span className="system-dot" />
      <span className="system-text">{text}</span>
    </div>
  )
}

function CompactionMeter({ message, percent, status, time, provider }: { message: string; percent?: number; status: 'started' | 'completed' | 'failed' | 'detected'; time: string; provider?: string }) {
  const pct = Math.max(0, Math.min(100, percent ?? 0))
  const active = status === 'started'
  const label = percent === undefined && active ? 'measuring' : `${pct.toFixed(0)}%`
  return (
    <div className={`compaction-meter ${status}`} role="status" aria-label="Session compaction progress">
      <div className="compaction-meter-head">
        <span className="compaction-meter-icon"><Icon name={active ? 'refresh' : status === 'failed' ? 'alert' : 'check'} size={12} /></span>
        <span className="compaction-meter-title">{provider ?? 'provider'} compaction</span>
        <span className="compaction-meter-pct">{label}</span>
      </div>
      <div className="compaction-meter-bar" aria-hidden="true">
        <div className="compaction-meter-fill" style={{ width: `${percent === undefined && active ? 100 : pct}%` }} />
      </div>
      <div className="compaction-meter-sub">
        <span>{message}</span>
        <span>{time}</span>
      </div>
    </div>
  )
}

function HandoffMeter({ message, percent, status, time, fromProvider, toProvider }: { message: string; percent?: number; status: 'started' | 'completed' | 'failed'; time: string; fromProvider?: string; toProvider?: string }) {
  const pct = Math.max(0, Math.min(100, percent ?? (status === 'started' ? 55 : 100)))
  const active = status === 'started'
  const route = fromProvider && toProvider ? `${fromProvider} → ${toProvider}` : toProvider ? `→ ${toProvider}` : 'agent handoff'
  return (
    <div className={`handoff-meter ${status}`} role="status" aria-label="Provider handoff progress">
      <div className="handoff-meter-head">
        <span className="handoff-meter-icon"><Icon name={active ? 'refresh' : status === 'failed' ? 'alert' : 'check'} size={12} /></span>
        <span className="handoff-meter-title">handing off to next agent</span>
        <span className="handoff-meter-pct">{active ? 'syncing' : `${pct.toFixed(0)}%`}</span>
      </div>
      <div className="handoff-meter-bar" aria-hidden="true">
        <div className="handoff-meter-fill" style={{ width: `${active ? Math.max(45, pct) : pct}%` }} />
      </div>
      <div className="handoff-meter-sub">
        <span>{message} · {route}</span>
        <span>{time}</span>
      </div>
    </div>
  )
}

function HandoffSummaryCard({ summary, time, fromProvider, toProvider, reason }: { summary: string; time: string; fromProvider?: string; toProvider?: string; reason?: 'handoff' | 'compact' }) {
  const route = reason === 'compact'
    ? (toProvider ?? fromProvider ?? 'provider')
    : fromProvider && toProvider ? `${fromProvider} → ${toProvider}` : toProvider ? `→ ${toProvider}` : 'provider handoff'
  const title = reason === 'compact' ? 'compact summary' : 'handoff summary'
  return (
    <div className="handoff-summary-card">
      <div className="handoff-summary-head">
        <span><Icon name="history" size={12} /> {title}</span>
        <span>{route} · {time}</span>
      </div>
      <pre className="handoff-summary-body">{summary}</pre>
    </div>
  )
}

// ── Turn → WorkLog row mapping ───────────────────────────────────────────────

function shortenPath(p: string, max = 72): string {
  if (!p || p.length <= max) return p
  return '…' + p.slice(-max + 1)
}

function formatBody(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function pickCommandPreview(args: unknown): string {
  if (typeof args === 'string') return args
  if (args && typeof args === 'object') {
    const obj = args as Record<string, unknown>
    if (typeof obj.command === 'string')       return obj.command
    if (Array.isArray(obj.command))             return obj.command.join(' ')
    if (typeof obj.cmd === 'string')           return obj.cmd
    if (typeof obj.script === 'string')        return obj.script
  }
  try { return JSON.stringify(args) } catch { return String(args) }
}

// Truncate a multi-line string to the first N lines per the spec's
// per-tool body limits (read=6, write/webfetch/default=10).
function truncateLines(s: string, n: number): string {
  if (!s) return ''
  const lines = s.split('\n')
  if (lines.length <= n) return s
  return lines.slice(0, n).join('\n') + `\n… (${lines.length - n} more lines)`
}

function langFromFilename(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  if (!m) return 'text'
  const ext = m[1].toLowerCase()
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    rb: 'ruby', php: 'php', swift: 'swift', cs: 'csharp', cpp: 'cpp',
    cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass',
    md: 'markdown', mdx: 'mdx', xml: 'xml', sql: 'sql',
    dockerfile: 'docker', env: 'bash', ini: 'ini',
  }
  return map[ext] ?? 'text'
}

function basename(p: string): string {
  if (!p) return ''
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? v as Record<string, unknown> : null
}

// LSP diagnostics may arrive on tool metadata (e.g. an edit tool that surfaces
// post-write errors). Accept either `diagnostics` or `lspDiagnostics` arrays;
// normalize the severity/line/message shape so renderers don't branch on it.
function extractDiagnostics(msg: ToolCallMessage): Diagnostic[] | undefined {
  const sources: unknown[] = [
    (msg.metadata as Record<string, unknown> | undefined)?.diagnostics,
    (msg.metadata as Record<string, unknown> | undefined)?.lspDiagnostics,
    asRecord(msg.result)?.diagnostics,
  ]
  for (const src of sources) {
    if (!Array.isArray(src) || src.length === 0) continue
    return src.map((d): Diagnostic => {
      const r = asRecord(d) ?? {}
      const sev = String(r.severity ?? r.level ?? 'error').toLowerCase()
      const severity: Diagnostic['severity'] =
        sev === 'warning' || sev === 'warn'   ? 'warning' :
        sev === 'info' || sev === 'information' ? 'info'   :
        sev === 'hint'                          ? 'hint'   :
        'error'
      const range = asRecord(r.range) ?? asRecord((r as Record<string, unknown>).start)
      const start = range ? (asRecord(range.start) ?? range) : null
      return {
        severity,
        message: String(r.message ?? r.text ?? ''),
        line:    typeof r.line === 'number' ? r.line : (typeof start?.line === 'number' ? start!.line as number : undefined),
        column:  typeof r.column === 'number' ? r.column : (typeof start?.character === 'number' ? start!.character as number : undefined),
        source:  typeof r.source === 'string' ? r.source : undefined,
      }
    })
  }
  return undefined
}

// Extract a todo list from args/result for the `todowrite` tool.
function extractTodos(msg: ToolCallMessage): TodoItem[] | undefined {
  return todosFromToolCall(msg) ?? undefined
}

// Extract a delegated tool-call summary for the `task` tool.
function extractTaskSummary(msg: ToolCallMessage): TaskSummaryItem[] | undefined {
  const r = asRecord(msg.result) ?? asRecord(msg.args)
  if (!r) return undefined
  const summary = r.summary ?? r.toolCalls ?? r.calls
  if (!Array.isArray(summary)) return undefined
  return summary.map(s => {
    const o = asRecord(s) ?? {}
    const task = todoItemFromUnknown(o.task ?? (o.status !== undefined && (o.subject !== undefined || o.content !== undefined) ? o : null)) ?? undefined
    return {
      tool: String(o.tool ?? o.name ?? 'tool'),
      text: task?.text ?? String(o.text ?? o.summary ?? o.command ?? o.path ?? ''),
      task,
    }
  })
}

// Per tool-calling-breakdown.md — produce the tool-specific title shown
// in the row header (e.g. "Read foo.ts", "Task[general] Search for files").
// Pending state ("Writing command...", "Preparing edit...") is handled in
// TurnWorkLog via row.pendingText.
function toolCallToRow(msg: ToolCallMessage): WorkLogRow {
  const status: WorkLogRow['status'] =
    msg.status === 'completed' ? 'done' :
    msg.status === 'error'     ? 'error' :
    msg.status === 'pending'   ? 'pending' :
    msg.status === 'running'   ? 'running' :
    'done'

  const name = (msg.toolName || 'tool').toLowerCase()
  const args = asRecord(msg.args)
  const meta = msg.metadata ?? null

  // File-edit tool calls captured by the bridge — render via the `edit` body
  // shape so the diff appears under a "Edit {filename}" title.
  if (msg.fileChange) {
    const changes = msg.fileChanges ?? [msg.fileChange]
    const primary = changes[0]
    const stats = diffStats(primary.patch)
    const suffix = changes.length > 1 ? ` (+${changes.length - 1} more)` : ''
    return {
      kind:     'edit',
      verb:     'Modified',
      title:    `Modified ${basename(primary.path)}${suffix}`,
      filename: basename(primary.path) + suffix,
      filePath: primary.path,
      added:    stats.added,
      removed:  stats.removed,
      label:    'File change',
      body:     shortenPath(primary.path),
      diff:     primary.patch,
      status,
      pendingText: 'Preparing edit...',
    }
  }

  // bash / shell — title is the actual command. Opencode's bash tool input
  // shape varies (`command`, `cmd`, `script`) — try each, then the bridge's
  // `state.title`, then the first non-empty line of output as a last resort.
  if (name === 'shell' || name === 'bash' || name === 'commandexecution') {
    const cmd =
      asString(args?.command) ??
      asString(args?.cmd) ??
      asString(args?.script) ??
      (Array.isArray(args?.command) ? (args!.command as unknown[]).join(' ') : undefined) ??
      ''
    const desc = asString(args?.description) ?? msg.title ?? ''
    const out  = asString(meta?.output) ?? (msg.isError ? formatBody(msg.result) : asString(msg.result))
    const headline = cmd || desc
    // Past-tense verb chip: "Ran bash" / "Ran Shell" — matches request spec.
    const toolDisplay = name === 'shell' ? 'Shell' : name === 'bash' ? 'bash' : (msg.toolName || 'bash')
    return {
      kind:   'bash',
      verb:   `Ran ${toolDisplay}`,
      title:  headline ? `$ ${headline}` : (status === 'running' || status === 'pending' ? 'Running...' : '$ (no command)'),
      label:  'Ran command',
      body:   cmd,
      output: out,
      lang:   'bash',
      detail: msg.isError ? formatBody(msg.result) : undefined,
      status,
      pendingText: 'Writing command...',
    }
  }

  // read — plain `Read filename.ext` title (no body chip).
  if (name === 'read') {
    const path     = asString(args?.path) ?? asString(args?.file_path) ?? asString(args?.filePath) ?? ''
    const filename = basename(path) || msg.title || 'file'
    const preview  = truncateLines(asString(meta?.preview) ?? asString(msg.result) ?? '', 6)
    return {
      kind:    'read',
      title:   `Read ${filename}`,
      filename,
      filePath: path || undefined,
      label:   'Read file',
      body:    '',
      preview: preview || undefined,
      lang:    langFromFilename(filename),
      status,
      pendingText: 'Reading...',
    }
  }

  // edit / apply_patch — "Edit {filename}" with diff + add/remove counts.
  if (name === 'apply_patch' || name === 'edit') {
    // The shared extractor handles every shape: a `{ changes: [...] }` array,
    // a nested `result.details.diff`, and add/delete/modify kinds — and rejects
    // line-numbered preview strings that aren't real unified diffs. Critically,
    // it never stringifies the whole result object as a fake patch.
    const provider = extractProviderPatchChanges(msg.metadata, msg.args, msg.result)
    const primary = provider[0]
    const path = primary?.path ?? pathField(args ?? {}) ?? ''
    // Only accept a metadata/args patch when it already looks like a unified
    // diff; otherwise leave the diff empty so the row shows without garbage.
    const rawMeta = asString(meta?.diff) ?? asString(args?.patch) ?? ''
    const diff = primary?.patch
      ?? (/^diff --git |^@@ /m.test(rawMeta) ? normalizePatchForPierre(path, rawMeta) : undefined)
    const stats  = diffStats(diff)
    const fname  = basename(path) || pickCommandPreview(msg.args)
    const suffix = provider.length > 1 ? ` (+${provider.length - 1} more)` : ''
    return {
      kind:     'edit',
      verb:     'Modified',
      title:    `Modified ${fname}${suffix}`,
      filename: fname + suffix,
      filePath: path || undefined,
      added:    stats.added,
      removed:  stats.removed,
      label:    'Modified file',
      body:     shortenPath(path),
      diff:     diff || undefined,
      status,
      pendingText: 'Preparing edit...',
    }
  }

  // write — "Write {filename}" with first 10 lines of content.
  if (name === 'write') {
    const path    = pathField(args ?? {}) ?? ''
    const content = asString(args?.content) ?? asString(args?.text) ?? formatBody(msg.result)
    // Treat a write as +N (lines written), -0.
    const added   = content ? content.split('\n').length : 0
    const fname   = basename(path) || pickCommandPreview(msg.args)
    return {
      kind:     'write',
      verb:     'Coding',
      title:    `Coding ${fname}`,
      filename: fname,
      filePath: path || undefined,
      added,
      removed:  0,
      label:    'Wrote file',
      body:     shortenPath(path),
      content:  truncateLines(content, 10) || undefined,
      lang:     langFromFilename(fname),
      status,
      pendingText: 'Writing file...',
    }
  }

  // webfetch — "Fetch {url}" with first 10 lines of fetched content.
  if (name === 'webfetch' || name === 'web_fetch') {
    const url     = asString(args?.url) ?? pickCommandPreview(msg.args)
    const fetched = truncateLines(asString(msg.result) ?? '', 10)
    return {
      kind:    'webfetch',
      title:   `Fetch ${url}`,
      label:   'Fetched URL',
      body:    url,
      fetched: fetched || undefined,
      status,
      pendingText: 'Fetching...',
    }
  }

  // todowrite — dynamic title based on todo phase + formatted checklist.
  if (name === 'todowrite' || name === 'todo_write') {
    const todos = extractTodos(msg) ?? []
    const allPending   = todos.length > 0 && todos.every(t => t.status === 'pending')
    const allCompleted = todos.length > 0 && todos.every(t => t.status === 'completed')
    const title =
      allPending   ? 'Creating plan' :
      allCompleted ? 'Completing plan' :
                     'Updating plan'
    return { kind: 'todowrite', title, label: title, body: '', todos, status, pendingText: 'Planning...' }
  }

  // todoread — hidden per spec.
  if (name === 'todoread' || name === 'todo_read') {
    return { kind: 'tool', title: 'Plan', label: 'Plan', body: '', status }
  }

  // task — "Task[subagent_type] {description}" + delegated tool list.
  if (name === 'task') {
    const subagent    = asString(args?.subagent_type) ?? asString(args?.agent) ?? 'general'
    const description = asString(args?.description) ?? asString(args?.prompt) ?? pickCommandPreview(msg.args)
    return {
      kind:        'task',
      title:       `Task[${subagent}] ${description}`,
      label:       'Delegated task',
      body:        description,
      taskSummary: extractTaskSummary(msg),
      status,
      pendingText: 'Delegating...',
    }
  }

  // glob — `Searched for {pattern}` (with optional `in {path}` scope).
  if (name === 'glob') {
    const pattern = asString(args?.pattern) ?? ''
    const scope   = asString(args?.path)
    const target  = scope ? basename(scope) : pattern
    const title   = target
      ? (scope && pattern ? `Searched For ${pattern} in ${basename(scope)}` : `Searched For ${target}`)
      : (msg.title || 'Searched')
    return { kind: 'glob', title, label: 'Globbed', body: '', status }
  }

  // grep — "Searched for X" or "Searched for X in <path>". Opencode's grep
  // tool input uses different field names depending on version — try them all.
  if (name === 'grep') {
    const pattern =
      asString(args?.pattern) ??
      asString(args?.query) ??
      asString(args?.regex) ??
      asString(args?.string) ??
      asString(args?.search) ??
      ''
    const scope =
      asString(args?.path) ??
      asString(args?.include) ??
      asString(args?.glob) ??
      asString(args?.dir)
    const title = pattern
      ? (scope ? `Searched For ${pattern} in ${basename(scope)}` : `Searched For ${pattern}`)
      : (msg.title || 'Searched')
    return { kind: 'grep', title, label: 'Grepped', body: '', status }
  }

  // list — `List {path}` (or just `List` if no path).
  if (name === 'list' || name === 'ls') {
    const path = asString(args?.path) ?? ''
    return { kind: 'list', title: path ? `List ${basename(path) || path}` : 'List', label: 'Listed', body: '', status }
  }

  // patch — "Patch".
  if (name === 'patch') {
    return { kind: 'patch', title: 'Patch', label: 'Patched', body: '', status }
  }

  // web_search — "Searched the web for X".
  if (name === 'web_search' || name === 'websearch') {
    const q = asString(args?.query) ?? ''
    return { kind: 'search', title: q ? `Searched the web for ${q}` : 'Searched the web', label: 'Searched web', body: '', status }
  }

  // Default: capitalized tool name + output truncated to 10 lines.
  const capName = (msg.toolName || 'tool').charAt(0).toUpperCase() + (msg.toolName || 'tool').slice(1)
  return {
    kind:   'tool',
    title:  `${capName} ${pickCommandPreview(msg.args)}`.trim(),
    label:  `Called ${msg.toolName || 'tool'}`,
    body:   pickCommandPreview(msg.args),
    detail: truncateLines(msg.isError ? formatBody(msg.result) : (asString(msg.result) ?? ''), 10) || undefined,
    status,
    pendingText: 'Calling tool...',
  }
}

interface TurnGroup {
  turnId: string
  rows:   WorkLogRow[]
  live:   boolean
  changedFiles: WorkLogChangedFile[]
  // Source identities let memoized anchors distinguish a real tool update from
  // unrelated thinking/text mutations elsewhere in the same live turn.
  sources: ToolCallMessage[]
  // Position of the first event in this contiguous tool run.
  anchorIdx: number
}

function changedFilesForSources(sources: ToolCallMessage[]): WorkLogChangedFile[] {
  return changesForToolMessages(sources).map(change => {
    const stats = diffStats(change.patch)
    return {
      path: change.path,
      name: basename(change.path),
      added: stats.added,
      removed: stats.removed,
    }
  })
}

/**
 * Build work-log groups in one pass. Until a response exists, contiguous tool
 * runs stay in stream order so live activity remains visible. Once a later
 * agent response exists for the turn, every earlier tool call is consolidated
 * into one log anchored directly before the turn's latest response.
 */
function buildTurnGroups(messages: Message[]): Map<number, TurnGroup> {
  const groups = new Map<number, TurnGroup>()
  const responseAnchorByTurn = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.kind === 'agent' && msg.turnId) responseAnchorByTurn.set(msg.turnId, i)
  }

  let current: TurnGroup | null = null
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.kind !== 'toolcall') {
      current = null
      continue
    }
    const toolName = (msg.toolName || '').toLowerCase()
    // TodoWrite / CrewCoder task mutations have a dedicated live surface above the composer.
    if (toolName === 'todowrite' || toolName === 'todo_write' || toolName === 'todoread' || toolName === 'todo_read') continue
    if (isCrewCoderTaskActivityTool(msg)) continue
    const turnId = msg.turnId
    if (!turnId) {
      current = null
      continue
    }

    const responseAnchor = responseAnchorByTurn.get(turnId)
    let group: TurnGroup
    if (responseAnchor !== undefined && responseAnchor > i) {
      group = groups.get(responseAnchor) ?? {
        turnId,
        rows: [],
        live: false,
        changedFiles: [],
        sources: [],
        anchorIdx: responseAnchor,
      }
      groups.set(responseAnchor, group)
      current = null
    } else {
      if (!current || current.turnId !== turnId) {
        current = { turnId, rows: [], live: false, changedFiles: [], sources: [], anchorIdx: i }
        groups.set(i, current)
      }
      group = current
    }

    group.sources.push(msg)
    const row = toolCallToRow(msg)
    const diag = extractDiagnostics(msg)
    if (diag && diag.length > 0) row.diagnostics = diag
    group.rows.push(row)
    if (msg.status === 'running' || msg.status === 'pending') group.live = true
  }
  for (const group of groups.values()) group.changedFiles = changedFilesForSources(group.sources)
  return groups
}

// Initial window and per-click step for the "load earlier" pager. Only the most
// recent PAGE_SIZE messages render until the user asks for more — this caps DOM
// nodes on long threads without virtualization (native scroll + Ctrl+F intact
// for what's loaded). The bottom of the thread is always rendered, so streaming
// and auto-scroll behave exactly as on a short thread.
const PAGE_SIZE = 50

interface MessagesProps {
  messages:    Message[]
  workspacePath?: string
  isRunning?: boolean
  loadingStatus?: string | null
  onOpenFile?: (path: string) => void
  onOpenTurnChange?: (target: TurnChangeTarget) => void
  onOpenLink?: (url: string) => void
  /** The thread's scroll element — used to keep the reading position pinned when
   *  older messages are prepended via the pager. */
  scrollParent?: HTMLElement | null
}

/** The turn a row's render depends on, if any (used to scope memo invalidation). */
function rowTurnId(msg: Message): string | undefined {
  if (msg.kind === 'agent' || msg.kind === 'thinking' || msg.kind === 'toolcall') return msg.turnId
  return undefined
}

interface MessageRowProps {
  msg:             Message
  index:           number
  groups:          Map<number, TurnGroup>
  isRunning:       boolean
  isWaitingAnchor: boolean
  showTurnSummary: boolean
  showStreamCursor: boolean
  turnChangeKey:   string
  workspacePath?:  string
  onOpenFile?:     (path: string) => void
  onOpenTurnChange?: (target: TurnChangeTarget) => void
  onOpenLink?:     (url: string) => void
}

/**
 * A row skips re-render unless its own message object or derived output changed.
 * The streaming updater shallow-copies the array and replaces only the changed
 * message; aggregated work-log anchors additionally compare their source rows.
 */
function areRowsEqual(prev: MessageRowProps, next: MessageRowProps): boolean {
  if (prev.msg !== next.msg) return false
  if (prev.workspacePath !== next.workspacePath) return false
  if (prev.isWaitingAnchor !== next.isWaitingAnchor) return false
  if (next.isWaitingAnchor && prev.isRunning !== next.isRunning) return false
  if (prev.turnChangeKey !== next.turnChangeKey) return false
  if (prev.showTurnSummary !== next.showTurnSummary) return false
  if (prev.showStreamCursor !== next.showStreamCursor) return false

  // A tool or final-response anchor may render a work-log group. Compare its
  // actual source identities rather than invalidating it for unrelated updates.
  const prevSources = prev.groups.get(prev.index)?.sources
  const nextSources = next.groups.get(next.index)?.sources
  if (prevSources === nextSources) return true
  if (!prevSources || !nextSources || prevSources.length !== nextSources.length) return false
  for (let i = 0; i < nextSources.length; i++) {
    if (prevSources[i] !== nextSources[i]) return false
  }
  return true
}

const MessageRow = React.memo(function MessageRow({
  msg, index, groups, isRunning, isWaitingAnchor, showTurnSummary, showStreamCursor, workspacePath, onOpenFile, onOpenTurnChange, onOpenLink,
}: MessageRowProps): React.ReactElement | null {
  switch (msg.kind) {
    case 'user':
      return <UserBubble text={msg.text} time={msg.time} speaker={msg.speaker} attachments={msg.attachments} workspacePath={workspacePath} />

    case 'worklog':
      // Legacy single-line worklog — render via TurnWorkLog with a single bash
      // row so all work-log surfaces flow through one component.
      return (
        <TurnWorkLog
          rows={[{
            kind:   'bash',
            verb:   'Ran Shell',
            title:  `$ ${msg.command}`,
            label:  'Ran command',
            body:   msg.command,
            output: undefined,
            lang:   'bash',
            status: 'done',
          }]}
          live={false}
          total={msg.count}
          onOpenFile={onOpenFile}
        />
      )

    case 'agent': {
      const workLog = groups.get(index)
      return (
        <>
          {workLog && (
            <TurnWorkLog
              rows={workLog.rows}
              live={workLog.live}
              changedFiles={workLog.changedFiles}
              onOpenFile={onOpenFile}
              onOpenChangedFile={path => onOpenTurnChange?.({ turnId: workLog.turnId, filePath: path })}
            />
          )}
          <AgentBubble blocks={msg.blocks} text={msg.text} chunks={msg.chunks} time={msg.time} streaming={msg.streaming} showStreamCursor={showStreamCursor} durationMs={msg.durationMs} usage={msg.usage} mode={msg.mode} showTurnSummary={showTurnSummary} onOpenLink={onOpenLink} />
        </>
      )
    }

    case 'thinking':
      return <ThinkingBlock text={msg.text} streaming={msg.streaming} chunks={msg.chunks} />

    case 'toolcall': {
      const g = groups.get(index)
      if (!g) return null
      return <TurnWorkLog rows={g.rows} live={g.live} onOpenFile={onOpenFile} />
    }

    // CrewCode-owned activity renders exclusively in AgentActivityOverlay.
    case 'activity':
      return null

    case 'system':
      return <SystemNotice text={msg.text} tone={msg.tone} />

    case 'compaction':
      return <CompactionMeter message={msg.message} percent={msg.percent} status={msg.status} time={msg.time} provider={msg.provider} />

    case 'handoff':
      return <HandoffMeter message={msg.message} percent={msg.percent} status={msg.status} time={msg.time} fromProvider={msg.fromProvider} toProvider={msg.toProvider} />

    case 'handoff_summary':
      return <HandoffSummaryCard summary={msg.summary} time={msg.time} fromProvider={msg.fromProvider} toProvider={msg.toProvider} reason={msg.reason} />
  }
}, areRowsEqual)

/** Stable identity for a row's React key. Falls back to index for kinds that
 *  carry no durable id; those are only ever appended, so the index is stable. */
function rowKey(msg: Message, index: number): string {
  switch (msg.kind) {
    case 'agent':    return `a-${msg.turnId ?? index}-${msg.processId ?? index}`
    case 'thinking': return `th-${msg.segmentId ?? msg.turnId ?? index}`
    case 'toolcall': return `tc-${msg.toolCallId ?? index}`
    case 'compaction': return `cm-${msg.bridgeId}-${index}`
    case 'handoff': return `ho-${msg.id}`
    case 'handoff_summary': return `hs-${index}`
    default:         return `${msg.kind[0]}-${index}`
  }
}

export function Messages({ messages, workspacePath, isRunning = false, loadingStatus = null, onOpenFile, onOpenTurnChange, onOpenLink, scrollParent }: MessagesProps) {
  const { state } = useSettings()
  // ── Pager: render only the most recent PAGE_SIZE rows ──────────────────────
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const displayEntries = useMemo(() => {
    const hideVerbose = state.hideVerboseAgentLogs
    return messages
      .map((msg, index) => ({ msg, index }))
      // Reasoning is never hidden. This preference only collapses tool/work logs.
      .filter(({ msg }) => !hideVerbose || (msg.kind !== 'toolcall' && msg.kind !== 'worklog'))
  }, [messages, state.hideVerboseAgentLogs])
  const hidden = Math.max(0, displayEntries.length - visibleCount)
  const visibleEntries = useMemo(() => displayEntries.slice(hidden), [displayEntries, hidden])
  const visibleMessages = useMemo(() => visibleEntries.map(entry => entry.msg), [visibleEntries])

  // Build expensive work-log/group metadata only for the rows that are actually
  // in the DOM. Streaming used to rescan every old tool call on each paint.
  const { groups, turnChangeKeys } = useMemo(() => {
    const localGroups = buildTurnGroups(visibleMessages)
    const indexedGroups = new Map<number, TurnGroup>()
    for (const [, group] of localGroups) {
      const anchor = visibleEntries[group.anchorIdx]
      if (anchor) indexedGroups.set(anchor.index, { ...group, anchorIdx: anchor.index })
    }

    const changeKeys = new Map<string, string>()
    for (const m of visibleMessages) {
      if (m.kind === 'toolcall' && m.turnId) {
        const changes = m.fileChanges ?? (m.fileChange ? [m.fileChange] : [])
        if (changes.length > 0) {
          const prev = changeKeys.get(m.turnId) ?? ''
          const key = changes.map(c => `${c.path}:${c.patch.length}`).join('|')
          changeKeys.set(m.turnId, prev ? `${prev}|${key}` : key)
        }
      }
    }
    return { groups: indexedGroups, turnChangeKeys: changeKeys }
  }, [visibleEntries, visibleMessages])

  const latestAgentRowIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === 'agent') return i
    }
    return -1
  }, [messages])

  const finalAgentRowIndices = useMemo(() => {
    const final = new Set<number>()
    const seenTurns = new Set<string>()
    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const { msg, index } = visibleEntries[i]
      const turnId = rowTurnId(msg)
      if (!turnId) continue
      if (msg.kind === 'agent' && !seenTurns.has(turnId)) final.add(index)
      seenTurns.add(turnId)
    }
    return final
  }, [visibleEntries])

  // Stable callback identities so memoized rows never re-render on a parent
  // re-binding these handlers, and skipped rows never hold a stale closure.
  const openFileRef = useRef(onOpenFile); openFileRef.current = onOpenFile
  const openTurnChangeRef = useRef(onOpenTurnChange); openTurnChangeRef.current = onOpenTurnChange
  const openLinkRef = useRef(onOpenLink); openLinkRef.current = onOpenLink
  const stableOpenFile = useMemo(() => (p: string) => openFileRef.current?.(p), [])
  const stableOpenTurnChange = useMemo(() => (target: TurnChangeTarget) => openTurnChangeRef.current?.(target), [])
  const stableOpenLink = useMemo(() => (u: string) => openLinkRef.current?.(u), [])

  // Waiting state: keep the loader visible for the whole provider turn. Some
  // agents stream reasoning/tools/final text separately; only turn_end means done.
  let waitingAfterIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'user') { waitingAfterIdx = i; break }
  }
  const showStickyLoader = isRunning && waitingAfterIdx !== -1

  // Row renderer — keeps the original message index so groups, the waiting
  // anchor, and live-turn tracking stay correct even when older rows are paged out.
  const renderRow = (msg: Message, i: number): React.ReactElement => (
    <MessageRow
      msg={msg}
      index={i}
      groups={groups}
      isRunning={isRunning}
      isWaitingAnchor={i === waitingAfterIdx}
      showTurnSummary={finalAgentRowIndices.has(i)}
      showStreamCursor={msg.kind === 'agent' && i === latestAgentRowIndex}
      turnChangeKey={msg.kind === 'agent' && msg.turnId ? (turnChangeKeys.get(msg.turnId) ?? '') : ''}
      workspacePath={workspacePath}
      onOpenFile={stableOpenFile}
      onOpenTurnChange={stableOpenTurnChange}
      onOpenLink={stableOpenLink}
    />
  )
  // Distance from the bottom is invariant across a top-prepend — capture it
  // before loading earlier rows, restore it after, so the view doesn't jump.
  const restoreFromBottom = useRef<number | null>(null)

  const loadEarlier = (): void => {
    if (scrollParent) restoreFromBottom.current = scrollParent.scrollHeight - scrollParent.scrollTop
    setVisibleCount(c => c + PAGE_SIZE)
  }

  useLayoutEffect(() => {
    if (scrollParent && restoreFromBottom.current !== null) {
      scrollParent.scrollTop = scrollParent.scrollHeight - restoreFromBottom.current
      restoreFromBottom.current = null
    }
  }, [visibleCount, scrollParent])

  return (
    <>
      {hidden > 0 && (
        <button type="button" className="thread-load-earlier" onClick={loadEarlier}>
          Load {Math.min(hidden, PAGE_SIZE)} earlier · {hidden} hidden
        </button>
      )}
      {visibleEntries.map(({ msg, index }) => (
        <React.Fragment key={rowKey(msg, index)}>{renderRow(msg, index)}</React.Fragment>
      ))}
      {showStickyLoader && (
        <div className="thread-sticky-loader">
          <LoadingBlock text="" streaming={true} time="" status={loadingStatus} />
        </div>
      )}
    </>
  )
}
