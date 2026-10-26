import type { ContextCategory, Message, TurnUsage } from '../../types'

/** The newest usage snapshot wins even when compaction cleared its occupancy. */
export function latestSessionUsage(messages: readonly Message[]): TurnUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.kind === 'agent' && message.usage) return message.usage
  }
  return undefined
}

const DETAIL_GROUPS: Array<[string, string]> = [
  ['mcp:', 'MCP tools'], ['builtin:', 'Deferred system tools'], ['system tool:', 'System tools'],
  ['system:', 'System prompt'], ['memory:', 'Memory files'], ['agent:', 'Agents'],
  ['skill:', 'Skills'], ['messages:', 'Messages'], ['tool calls:', 'Tool calls'],
  ['attachment:', 'Attachments'], ['api usage:', 'API usage counters'], ['sdk:', 'Provider diagnostics'],
]

export function contextUsageRows(usage?: TurnUsage) {
  const categories: ContextCategory[] = []
  const groups = new Map<string, ContextCategory[]>()
  for (const row of usage?.contextBreakdown ?? []) {
    // Usage counters overlap; grouping them as context categories implies a false total.
    const match = usage?.contextBreakdownSource === 'context'
      ? DETAIL_GROUPS.find(([prefix]) => row.name.startsWith(prefix)) : undefined
    if (!match) { categories.push(row); continue }
    const [prefix, label] = match
    const entries = groups.get(label) ?? []
    entries.push({ ...row, name: row.name.slice(prefix.length) })
    groups.set(label, entries)
  }
  return { categories, groups: [...groups].map(([name, rows]) => ({ name, rows })) }
}

/** Native events describe observed lifecycle, never a predicted start time. */
export function latestSessionCompaction(messages: readonly Message[], provider?: string) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.kind === 'compaction' && (!provider || message.provider === provider)) return message
  }
  return undefined
}
