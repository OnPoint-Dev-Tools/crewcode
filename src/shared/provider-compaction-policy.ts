/** Observed provider policy, separate from context capacity and UI warning levels. */
export interface ProviderCompactionPolicy {
  provider: 'codex' | 'claude' | 'crewcoder'
  enabled?: boolean
  thresholdTokens?: number
  source?: 'configuration'
  scope?: 'total' | 'body_after_prefix'
}

export function codexCompactionPolicy(result: Record<string, unknown>): ProviderCompactionPolicy {
  const config = result.config && typeof result.config === 'object' && !Array.isArray(result.config)
    ? result.config as Record<string, unknown> : {}
  const threshold = config.model_auto_compact_token_limit
  const scope = config.model_auto_compact_token_limit_scope
  return {
    provider: 'codex',
    ...(typeof threshold === 'number' && Number.isSafeInteger(threshold) && threshold > 0
      ? { thresholdTokens: threshold, source: 'configuration' as const,
          ...(scope === undefined || scope === 'total' ? { scope: 'total' as const }
            : scope === 'body_after_prefix' ? { scope: 'body_after_prefix' as const } : {}) }
      : {}),
  }
}
