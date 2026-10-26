import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CompactionMessage, ContextCategory, TurnUsage } from '../../types'
import { contextUsageRows } from './context-usage-breakdown'
import { Icon, type IconName } from '../ui/Icon'

function tokenRowIcon(name: string, group?: string): IconName {
  const label = (group ?? name).toLowerCase()
  if (/mcp/.test(label)) return 'plug'
  if (/memory|attachment/.test(label)) return label.includes('attachment') ? 'paperclip' : 'fileText'
  if (/skill|command/.test(label)) return 'skill'
  if (/agent/.test(label)) return 'bot'
  if (/reason|thinking/.test(label)) return 'thought'
  if (/cache/.test(label)) return 'archive'
  if (/tool/.test(label)) return 'wrench'
  if (/message/.test(label)) return 'message'
  if (/system|prompt/.test(label)) return 'cpu'
  if (/input/.test(label)) return 'arrowDown'
  if (/output/.test(label)) return 'arrowUp'
  if (/free|headroom|buffer/.test(label)) return 'battery'
  if (/diagnostic/.test(label)) return 'inspection'
  if (/context/.test(label)) return 'brain'
  return 'circleDot'
}

function TokenCount({ value }: { value: number }) {
  const text = new Intl.NumberFormat('en-US', {
    notation: 'compact', maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value).replace('K', 'k')
  const exact = value.toLocaleString('en-US') + ' tokens'
  return <span title={exact} aria-label={exact}>{text}</span>
}

function TokenLogLabel({ children, icon }: { children: React.ReactNode; icon: IconName }) {
  return <dt><Icon name={icon} size={14} aria-hidden="true" focusable="false" /><span>{children}</span></dt>
}

export function ContextUsageSidebar({ usage, onClose, provider, compaction, title = 'Context management' }: {
  usage?: TurnUsage; onClose: () => void; title?: string; provider?: string; compaction?: CompactionMessage
}) {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key !== 'Tab') return
      const controls = panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [href], [tabindex="0"]')
      if (!controls?.length) return
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); if (opener?.isConnected) opener.focus() }
  }, [onClose])
  const { categories, groups } = contextUsageRows(usage)
  const policy = !provider || usage?.compactionPolicy?.provider === provider ? usage?.compactionPolicy : undefined
  const owner = provider ?? policy?.provider
  const status = compaction?.status === 'started' ? 'Compacting'
    : compaction?.status === 'completed' ? 'Last compaction completed'
      : compaction?.status === 'failed' ? 'Last compaction failed or was interrupted'
        : compaction?.status === 'detected' ? 'Context drop detected (inferred)' : 'No compaction event observed'
  const window = usage?.contextWindow
  const used = usage?.contextTokens
  const measured = used !== undefined && window !== undefined && window > 0
  const percent = measured ? Math.min(100, Math.max(0, used / window * 100)) : undefined
  const context = usage?.contextBreakdownSource === 'context'
  const rows = (items: ContextCategory[], showPercent = false, group?: string) => <dl className="token-logs-rows">
    {items.map((row, index) => <div className="token-logs-row" key={row.name + index}>
      <TokenLogLabel icon={tokenRowIcon(row.name, group)}>{row.name}{row.deferred ? ' (reserved / deferred)' : ''}</TokenLogLabel>
      <dd>{<TokenCount value={row.tokens} />}{showPercent && context && window && !row.deferred
        ? <span className="context-row-percent">{(row.tokens / window * 100).toFixed(1)}%</span> : null}</dd>
    </div>)}
  </dl>
  return createPortal(<div className="token-logs-layer">
    <button type="button" className="token-logs-backdrop" onClick={onClose} aria-label="Close context management" />
    <aside ref={panelRef} className="token-logs-sidebar context-usage-sidebar" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="token-logs-header">
        <div><div className="token-logs-kicker">Session context</div><h2 id={titleId}>{title}</h2></div>
        <button ref={closeRef} type="button" className="token-logs-close" onClick={onClose} aria-label="Close context management">×</button>
      </header>
      <div className="token-logs-summary">
        {measured ? <><div className="context-usage-headline"><strong>{percent!.toFixed(1)}% used</strong><span><TokenCount value={used} /> / <TokenCount value={window} /></span></div>
          <div className="context-usage-bar" role="progressbar" aria-label="Session context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: percent + '%' }} />
          </div></> : <span>Context usage unavailable</span>}
        {usage?.model && <div className="token-logs-model">{usage.model}</div>}
        {usage?.promptBudgetTokens && <div className="token-logs-model">Codex prompt budget: <TokenCount value={usage.promptBudgetTokens} /> tokens</div>}
      </div>
      <div className="token-logs-body">
        <div className="token-logs-section-title">Compaction</div>
        <dl className="token-logs-rows">
          <div className="token-logs-row"><TokenLogLabel icon="bot">Managed by</TokenLogLabel><dd>{owner ?? 'Provider'}</dd></div>
          <div className="token-logs-row"><TokenLogLabel icon="refresh">Automatic compaction</TokenLogLabel><dd>{policy?.enabled === true ? 'Enabled' : policy?.enabled === false ? 'Disabled' : 'Provider default (not reported)'}</dd></div>
          <div className="token-logs-row"><TokenLogLabel icon="target">Configured threshold</TokenLogLabel><dd>{policy?.thresholdTokens !== undefined ? <><TokenCount value={policy.thresholdTokens} /> tokens</> : 'Unknown / not reported'}</dd></div>
          {policy?.thresholdTokens !== undefined && <div className="token-logs-row"><TokenLogLabel icon="grid">Threshold scope</TokenLogLabel><dd>{policy.scope === 'total' ? 'Full active context' : policy.scope === 'body_after_prefix' ? 'Growth after compacted prefix' : 'Not reported'}</dd></div>}
          <div className="token-logs-row"><TokenLogLabel icon="inspection">Observed status</TokenLogLabel><dd>{status}</dd></div>
          {compaction && <div className="token-logs-row"><TokenLogLabel icon="history">Last operation</TokenLogLabel><dd>{compaction.automatic ? 'Automatic' : 'Manual /compact'}</dd></div>}
        </dl>
        <p className="token-logs-note">The provider owns automatic compaction. A configured threshold is separate from the model window and prompt budget, and is not a countdown. Native model defaults may not be exposed.</p>

        <div className="token-logs-section-title">{context ? "What's using it" : 'Provider token counts'}</div>
        <p className="token-logs-note">{context
          ? 'Provider-reported context categories. Expanded detail can overlap category totals; reserved and deferred rows are separate from active usage.'
          : 'Request, turn, and session counters can overlap. They do not add up to context occupancy; this provider has not reported a category breakdown.'}</p>
        {rows(categories, true)}
        {groups.map(group => <details className="context-detail-group" key={group.name}>
          <summary>{group.name}<span>{group.rows.length}</span></summary>
          {rows(group.rows, false, group.name)}
        </details>)}
        {!categories.length && !groups.length && <p className="context-usage-empty">No context breakdown reported for this session yet. Send a message to receive the provider's next available reading.</p>}
        <p className="token-logs-note">Latest reported snapshot. Updates when the provider reports usage.</p>
      </div>
    </aside>
  </div>, document.body)
}
