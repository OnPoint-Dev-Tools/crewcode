import { describe, expect, it } from 'vitest'

import { CODEX_COMPACT_METHOD, codexApprovalDecisionForMode, getModeConfig, mapCodexEffort, usageFromCodexTokenUsage } from './codex-bridge'

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
      // 200K documented window wins over the 258,400 prompt budget Codex reports.
      contextWindow: 200_000,
      model: 'gpt-5.4-mini',
    })
  })

  it('uses the documented Codex GPT-5.5 context window instead of the prompt budget', () => {
    const usage = usageFromCodexTokenUsage({
      tokenUsage: {
        modelContextWindow: 272_000,
        total: { inputTokens: 120_000, outputTokens: 7_000, totalTokens: 127_000 },
        last:  { inputTokens: 18_000, outputTokens: 600, totalTokens: 18_600 },
      },
    }, 'gpt-5.5')

    expect(usage).toMatchObject({
      inputTokens: 18_000,
      outputTokens: 600,
      contextTokens: 18_600,
      contextWindow: 400_000,
      model: 'gpt-5.5',
    })
  })

  it('caps displayed Codex context usage at the selected model window', () => {
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
      model: 'gpt-5.5',
    })
  })
})
