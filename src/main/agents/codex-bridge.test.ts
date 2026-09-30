import { describe, expect, it } from 'vitest'

import { CODEX_COMPACT_METHOD, codexApprovalDecisionForMode, codexNativeCompactionStatus, getModeConfig, mapCodexEffort, usageFromCodexTokenUsage } from './codex-bridge'
import { normalizeContextUsage } from './compaction-meter'

describe('codex bridge mode config', () => {
  it.each([
    ['ask', 'read-only', 'untrusted', true],
    ['plan', 'read-only', 'untrusted', true],
    ['build', 'workspace-write', 'on-request', false],
    ['full', 'workspace-write', 'never', false],
  ] as const)('maps %s to the expected sandbox and approval policy', (mode, sandbox, approvalPolicy, readOnlyTools) => {
    const config = getModeConfig(mode)

    expect(config.sandbox).toBe(sandbox)
    expect(config.approvalPolicy).toBe(approvalPolicy)
    if (readOnlyTools) {
      expect(config.allowTools).not.toBeNull()
      expect(config.allowTools?.has('read')).toBe(true)
      expect(config.allowTools?.has('grep')).toBe(true)
      expect(config.allowTools?.has('write')).toBe(false)
      expect(config.allowTools?.has('bash')).toBe(false)
    } else {
      expect(config.allowTools).toBeNull()
    }
  })

  it('defaults to normal build behavior when no mode is supplied', () => {
    expect(getModeConfig()).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      allowTools: null,
    })
  })

  it.each([
    ['ask', 'decline'],
    ['plan', 'decline'],
    ['build', null],
    ['full', 'accept'],
    [undefined, null],
  ] as const)('uses %s mode for live approval requests', (mode, decision) => {
    expect(codexApprovalDecisionForMode(mode)).toBe(decision)
  })

  it('uses the app-server thread compaction method', () => {
    expect(CODEX_COMPACT_METHOD).toBe('thread/compact/start')
  })

  it('recognizes the native Codex compaction lifecycle and legacy completion', () => {
    expect(codexNativeCompactionStatus('item/started', { type: 'contextCompaction', id: 'compact-1' })).toBe('started')
    expect(codexNativeCompactionStatus('item/completed', { type: 'contextCompaction', id: 'compact-1' })).toBe('completed')
    expect(codexNativeCompactionStatus('thread/compacted', undefined)).toBe('completed')
    expect(codexNativeCompactionStatus('item/started', { type: 'agentMessage', id: 'message-1' })).toBeNull()
  })

  it('passes native reasoning effort through without downgrading xhigh', () => {
    expect(mapCodexEffort('off')).toBeUndefined()
    expect(mapCodexEffort('low')).toBe('low')
    expect(mapCodexEffort('xhigh')).toBe('xhigh')
    expect(mapCodexEffort('max')).toBe('max')
    expect(mapCodexEffort('ultra')).toBe('ultra')
  })

  it('uses latest prompt tokens instead of cumulative thread totals for context usage', () => {
    const usage = usageFromCodexTokenUsage({
      tokenUsage: {
        modelContextWindow: 258_400,
        total: { inputTokens: 210_000, outputTokens: 7_000, totalTokens: 217_000 },
        last:  { inputTokens: 12_000, outputTokens: 400, totalTokens: 12_400 },
      },
    }, 'gpt-5.4-mini')

    expect(usage).toMatchObject({
      inputTokens: 12_000,
      outputTokens: 400,
      totalTokens: 12_400,
      contextTokens: 12_400,
      contextWindow: 258_400,
      model: 'gpt-5.4-mini',
    })
  })

  it('separates Codex prompt budget from known model capacity', () => {
    const usage = usageFromCodexTokenUsage({
      tokenUsage: {
        modelContextWindow: 272_000,
        total: { inputTokens: 120_000, outputTokens: 7_000, totalTokens: 127_000 },
        last:  { inputTokens: 18_000, outputTokens: 600, cachedInputTokens: 4_000, reasoningOutputTokens: 250, totalTokens: 18_600 },
      },
    }, 'gpt-5.5')

    expect(usage).toMatchObject({
      inputTokens: 18_000,
      outputTokens: 600,
      contextTokens: 18_600,
      contextWindow: 400_000,
      promptBudgetTokens: 272_000,
      contextIsAuthoritative: true,
      contextBreakdownSource: 'usage',
      contextBreakdown: [
        { name: 'Latest request input', tokens: 18_000 },
        { name: 'Latest request output', tokens: 600 },
        { name: 'Cached input (included in input)', tokens: 4_000 },
        { name: 'Reasoning output (included in output)', tokens: 250 },
      ],
      model: 'gpt-5.5',
    })
  })

  it('caps displayed Codex context usage at the model window', () => {
    const usage = usageFromCodexTokenUsage({
      tokenUsage: {
        modelContextWindow: 272_000,
        total: { inputTokens: 403_000, outputTokens: 963, totalTokens: 403_963 },
        last:  { inputTokens: 403_000, outputTokens: 963, totalTokens: 403_963 },
      },
    }, 'gpt-5.5')

    expect(usage).toMatchObject({
      inputTokens: 403_000,
      outputTokens: 963,
      contextTokens: 400_000,
      contextWindow: 400_000,
      promptBudgetTokens: 272_000,
      model: 'gpt-5.5',
    })
  })

  it('falls back to model metadata when the app-server omits its window', () => {
    const usage = usageFromCodexTokenUsage({
      tokenUsage: { last: { inputTokens: 18_000, outputTokens: 600 } },
    }, 'gpt-5.5')

    expect(usage?.contextWindow).toBe(400_000)
  })

  it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'shows the full 1.05M window for %s separately from Codex\'s smaller prompt budget', model => {
      const usage = usageFromCodexTokenUsage({
        tokenUsage: {
          modelContextWindow: 828_400,
          last: { inputTokens: 18_000, outputTokens: 592 },
        },
      }, model)

      expect(usage).toMatchObject({
        contextTokens: 18_592,
        contextWindow: 1_050_000,
        promptBudgetTokens: 828_400,
        contextIsAuthoritative: true,
      })
    },
  )

  it('uses the reported budget as the window when full model capacity is unknown', () => {
    const usage = usageFromCodexTokenUsage({
      tokenUsage: { modelContextWindow: 828_400, last: { inputTokens: 18_000, outputTokens: 592 } },
    }, 'custom-unknown-model')

    expect(usage?.contextWindow).toBe(828_400)
    expect(usage?.promptBudgetTokens).toBeUndefined()
  })

  it('keeps a smaller native reading after Codex compacts context', () => {
    const previous = usageFromCodexTokenUsage({ tokenUsage: {
      modelContextWindow: 272_000,
      last: { inputTokens: 180_000, outputTokens: 2_000 },
    } }, 'gpt-5.5')
    const next = usageFromCodexTokenUsage({ tokenUsage: {
      modelContextWindow: 272_000,
      last: { inputTokens: 28_000, outputTokens: 500 },
    } }, 'gpt-5.5')

    expect(normalizeContextUsage(previous, next, { provider: 'codex' })?.contextTokens).toBe(28_500)
  })
})
