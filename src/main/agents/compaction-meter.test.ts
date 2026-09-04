import { describe, expect, it } from 'vitest'

import { autoCompactionSignalForProvider, detectAutoCompaction, normalizeContextUsage, compactionStrategy } from './compaction-meter'

describe('compactionStrategy', () => {
  const base = { httpOnly: false, nativeResume: false, hasConversationKey: true }

  it('uses the native rpc when the bridge exposes compact()', () => {
    expect(compactionStrategy({ ...base, provider: 'codex', hasNativeCompact: true, nativeResume: true })).toBe('native')
    expect(compactionStrategy({ ...base, provider: 'claude', hasNativeCompact: true, nativeResume: true })).toBe('native')
    expect(compactionStrategy({ ...base, provider: 'opencode', hasNativeCompact: true, nativeResume: true })).toBe('native')
  })

  it('uses local-summary for http-only providers and plugins', () => {
    expect(compactionStrategy({ ...base, provider: 'ollama', hasNativeCompact: false, httpOnly: true })).toBe('local-summary')
    expect(compactionStrategy({ ...base, provider: 'plugin:acme', hasNativeCompact: false })).toBe('local-summary')
  })

  it('uses summary-reset for native-session providers with no compact rpc', () => {
    // Pi/Hermes and older CrewCoder versions keep server-side sessions without
    // an advertised compact RPC, so we seed a fresh session with a summary.
    expect(compactionStrategy({ ...base, provider: 'pi', hasNativeCompact: false, nativeResume: true })).toBe('summary-reset')
    expect(compactionStrategy({ ...base, provider: 'hermes', hasNativeCompact: false, nativeResume: true })).toBe('summary-reset')
    expect(compactionStrategy({ ...base, provider: 'crewcoder', hasNativeCompact: false, nativeResume: true })).toBe('summary-reset')
  })

  it('is unsupported when summary-reset has no thread to seed', () => {
    // No conversation key → nowhere to persist the summary for replay.
    expect(compactionStrategy({ ...base, provider: 'pi', hasNativeCompact: false, nativeResume: true, hasConversationKey: false })).toBe('unsupported')
  })
})

describe('autoCompactionSignalForProvider', () => {
  it.each([
    ['claude', 'native'],
    ['crewcoder', 'native'],
    ['codex', 'usage'],
    ['opencode', 'usage'],
    ['pi', 'none'],
    ['hermes', 'none'],
    ['ollama', 'none'],
    ['openrouter', 'none'],
    ['plugin:acme', 'none'],
  ] as const)('classifies %s as %s', (provider, signal) => {
    expect(autoCompactionSignalForProvider(provider)).toBe(signal)
  })
})

describe('detectAutoCompaction', () => {
  const before = { contextTokens: 170_000, contextWindow: 200_000 }
  const after = { contextTokens: 20_000, contextWindow: 200_000 }

  it('starts a loading meter for a mid-turn context drop', () => {
    expect(detectAutoCompaction(before, after, 'usage_update')).toBe('started')
  })

  it('reports an end-of-turn-only drop as detected, not loading', () => {
    expect(detectAutoCompaction(before, after, 'turn_end')).toBe('detected')
  })

  it('ignores ordinary context changes', () => {
    expect(detectAutoCompaction(before, { contextTokens: 160_000, contextWindow: 200_000 }, 'usage_update')).toBeNull()
  })
})

describe('normalizeContextUsage', () => {
  it('holds the baseline plus new output when a provider under-reports context', () => {
    const usage = normalizeContextUsage(
      { contextTokens: 20_000, contextWindow: 200_000, totalTokens: 20_000 },
      { inputTokens: 300, outputTokens: 700, totalTokens: 1_000, contextTokens: 1_000, contextWindow: 200_000 },
    )

    // baseline (20_000) + new output (700) — never the re-sent input.
    expect(usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 700,
      totalTokens: 1_000,
      contextTokens: 20_700,
      contextWindow: 200_000,
    })
  })

  it('does not balloon on the first resumed turn (regression)', () => {
    // Last night ended at ~70k. On resume the provider re-sends the whole
    // history as input and reports a slightly lower absolute context. The meter
    // must stay ~70k, not 70k + 60k of re-sent history.
    const usage = normalizeContextUsage(
      { contextTokens: 70_000, contextWindow: 200_000, model: 'claude' },
      { inputTokens: 60_000, outputTokens: 800, totalTokens: 60_800, contextTokens: 65_000, contextWindow: 200_000 },
    )

    expect(usage?.contextTokens).toBe(70_800)
  })

  it('never reports more context than the window', () => {
    const usage = normalizeContextUsage(
      { contextTokens: 199_900, contextWindow: 200_000 },
      { inputTokens: 199_000, outputTokens: 5_000, totalTokens: 204_000, contextTokens: 150_000, contextWindow: 200_000 },
    )

    expect(usage?.contextTokens).toBe(200_000)
  })

  it('allows likely auto-compaction drops after high context usage', () => {
    const usage = normalizeContextUsage(
      { contextTokens: 170_000, contextWindow: 200_000, totalTokens: 170_000 },
      { inputTokens: 20_000, outputTokens: 500, totalTokens: 20_500, contextTokens: 20_500, contextWindow: 200_000 },
    )

    expect(usage?.contextTokens).toBe(20_500)
  })

  it('keeps regular context usage separate from compaction state', () => {
    const usage = normalizeContextUsage(undefined, {
      inputTokens: 54_000,
      outputTokens: 500,
      totalTokens: 54_500,
      contextTokens: 54_500,
      contextWindow: 100_000,
    })

    expect(usage).toMatchObject({
      contextTokens: 54_500,
      contextWindow: 100_000,
    })
    expect(usage?.compaction).toBeUndefined()
  })

  it('does not pin authoritative Claude SDK context to a stale full baseline', () => {
    const usage = normalizeContextUsage(
      { contextTokens: 1_000_000, contextWindow: 1_000_000, model: 'claude-opus-4-8' },
      {
        inputTokens: 1_200,
        outputTokens: 80,
        totalTokens: 1_280,
        contextTokens: 322_175,
        contextWindow: 1_000_000,
        model: 'claude-opus-4-8',
        contextBreakdown: [{ name: 'system', tokens: 250_000 }],
      },
      { provider: 'claude' },
    )

    expect(usage).toMatchObject({
      contextTokens: 322_175,
      contextWindow: 1_000_000,
      model: 'claude-opus-4-8',
    })
  })

  it('still floors Claude fallback billing usage when SDK context is unavailable', () => {
    const usage = normalizeContextUsage(
      { contextTokens: 322_175, contextWindow: 1_000_000, model: 'claude-opus-4-8' },
      { inputTokens: 1_200, outputTokens: 80, totalTokens: 1_280, contextTokens: 1_280, contextWindow: 1_000_000, model: 'claude-opus-4-8' },
      { provider: 'claude' },
    )

    expect(usage).toMatchObject({
      contextTokens: 322_255,
      contextWindow: 1_000_000,
      model: 'claude-opus-4-8',
    })
  })

  it('keeps the SDK-reported Claude window even when model metadata is unknown', () => {
    const usage = normalizeContextUsage(undefined, {
      contextTokens: 40_000,
      contextWindow: 1_000_000,
      model: undefined,
    }, { provider: 'claude' })

    expect(usage).toMatchObject({
      contextTokens: 40_000,
      contextWindow: 1_000_000,
    })
  })

  it('does not fabricate a Claude window when SDK and model metadata are unavailable', () => {
    const usage = normalizeContextUsage(undefined, {
      contextTokens: 40_000,
      model: undefined,
    }, { provider: 'claude' })

    expect(usage).toMatchObject({
      contextTokens: 40_000,
    })
    expect(usage?.contextWindow).toBeUndefined()
  })
})
