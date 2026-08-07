import type { CompactionStatus, TurnUsage } from './bridge-types'
import { contextWindowFor } from './model-context'

const DEFAULT_THRESHOLD_PERCENT = 80

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function buildCompactionStatus(opts: {
  provider: string
  used?: unknown
  limit?: unknown
  percent?: unknown
  threshold?: unknown
  metric?: CompactionStatus['metric']
  state?: CompactionStatus['state']
  reason?: unknown
}): CompactionStatus | undefined {
  const used = num(opts.used)
  const limit = num(opts.limit)
  const threshold = num(opts.threshold) ?? DEFAULT_THRESHOLD_PERCENT
  const percent = num(opts.percent) ?? (used !== undefined && limit && limit > 0 ? (used / limit) * 100 : undefined)

  if (used === undefined && limit === undefined && percent === undefined && !opts.state) return undefined

  const state = opts.state ?? (
    percent === undefined
      ? 'unknown'
      : percent >= 95
        ? 'critical'
        : percent >= threshold
          ? 'warning'
          : 'safe'
  )

  return {
    used,
    limit,
    percent,
    threshold,
    state,
    metric: opts.metric ?? 'tokens',
    providerLabel: opts.provider,
    reason: typeof opts.reason === 'string' ? opts.reason : undefined,
  }
}

export type CompactionStrategy = 'native' | 'local-summary' | 'summary-reset' | 'unsupported'

// Picks how /compact runs for a provider:
// - native        → the bridge exposes a real compact() RPC (claude /compact,
//                    codex thread/compact, opencode /summarize, plugins).
// - local-summary → CrewCode owns the replay history (HTTP_ONLY) so it asks for a
//                    summary and replaces the stored messages with it.
// - summary-reset → native-session providers with no compaction RPC (pi, hermes, CrewCoder):
//                    have the agent summarize its own live context, then start a
//                    fresh upstream session seeded with that summary.
// - unsupported   → nothing safe to do; report it instead of sending the literal
//                    "/compact" string, which the agent would answer as a message.
export function compactionStrategy(opts: {
  provider: string
  hasNativeCompact: boolean
  httpOnly: boolean
  nativeResume: boolean
  hasConversationKey: boolean
}): CompactionStrategy {
  if (opts.hasNativeCompact) return 'native'
  if (opts.httpOnly || opts.provider.startsWith('plugin:')) return 'local-summary'
  if (opts.nativeResume && opts.hasConversationKey) return 'summary-reset'
  return 'unsupported'
}

export function isLikelyAutoCompaction(previous: TurnUsage | undefined, next: TurnUsage | undefined, threshold = DEFAULT_THRESHOLD_PERCENT): boolean {
  if (!previous?.contextTokens || !next?.contextTokens || !previous.contextWindow) return false
  const previousPercent = (previous.contextTokens / previous.contextWindow) * 100
  // Providers rarely announce auto-compaction consistently; a large context drop
  // after warning-level usage is the safest cross-provider signal we can infer.
  return previousPercent >= threshold && next.contextTokens < previous.contextTokens * 0.6
}

export type AutoCompactionDetection = 'started' | 'detected' | null
export type AutoCompactionSignal = 'native' | 'usage' | 'none'

/**
 * Provider-specific auto-compaction observability. `native` bridges emit their
 * own authoritative boundaries; `usage` providers expose absolute live context
 * occupancy, allowing a high-water → large-drop inference. Everything else is
 * excluded rather than guessed from merely being a CLI.
 */
export function autoCompactionSignalForProvider(provider: string): AutoCompactionSignal {
  switch (provider.toLowerCase()) {
    case 'claude':
      return 'native'
    case 'codex':
    case 'opencode':
    case 'crewcoder':
      return 'usage'
    default:
      return 'none'
  }
}

/**
 * A mid-turn drop can truthfully open a loading meter until turn_end. Providers
 * that only publish usage at turn_end can only be reported after the fact.
 */
export function detectAutoCompaction(
  previous: TurnUsage | undefined,
  next: TurnUsage | undefined,
  eventType: 'usage_update' | 'turn_end',
): AutoCompactionDetection {
  if (!isLikelyAutoCompaction(previous, next)) return null
  return eventType === 'usage_update' ? 'started' : 'detected'
}

// Tokens genuinely added to context this turn, on top of an absolute prior
// baseline. Only the assistant *output* is new — a turn's `input` re-sends the
// whole conversation, which `previous.contextTokens` already accounts for, so
// adding it would double-count the history (the resume "ballooning" bug).
function newOutputTokens(usage: TurnUsage): number {
  const output = num(usage.outputTokens)
  return output !== undefined && output > 0 ? output : 0
}

export function normalizeContextUsage(previous: TurnUsage | undefined, next: TurnUsage | undefined, opts?: { provider?: string }): TurnUsage | undefined {
  if (!next) return next

  const provider = opts?.provider?.toLowerCase()
  const fallbackContextWindow = provider === 'claude'
    ? contextWindowFor(next.model) ?? contextWindowFor(previous?.model) ?? contextWindowFor('claude')
    : undefined
  const previousUsage = previous
  const usage: TurnUsage = { ...next }
  if (usage.compaction) delete usage.compaction
  if (usage.contextWindow === undefined) {
    usage.contextWindow = fallbackContextWindow ?? previousUsage?.contextWindow
  }

  const contextTokens = num(usage.contextTokens)
  const isAuthoritativeClaudeContext = provider === 'claude' && usage.contextBreakdown !== undefined

  if (
    previousUsage?.contextTokens !== undefined
    && contextTokens !== undefined
    && contextTokens < previousUsage.contextTokens
    && !isLikelyAutoCompaction(previousUsage, usage)
    && !isAuthoritativeClaudeContext
  ) {
    // A dip below the prior baseline means the provider under-reported the
    // absolute context (e.g. a fresh resume, or claude's active-only category
    // count). Hold the baseline and add only the new output — never the re-sent
    // input — so the meter can't jump by a whole conversation on the first
    // resumed turn. Cap at the window so it can never exceed 100%.
    const floored = previousUsage.contextTokens + newOutputTokens(usage)
    usage.contextTokens = usage.contextWindow && usage.contextWindow > 0
      ? Math.min(floored, usage.contextWindow)
      : floored
  }

  if (usage.contextWindow && usage.contextWindow > 0 && usage.contextTokens && usage.contextTokens > usage.contextWindow) {
    usage.contextTokens = usage.contextWindow
  }

  return usage
}
