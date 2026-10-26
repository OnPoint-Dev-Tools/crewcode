import { describe, expect, it } from 'vitest'
import { codexCompactionPolicy } from './provider-compaction-policy'

describe('Codex compaction threshold evidence', () => {
  it('keeps defaults unknown instead of deriving a trigger from model capacity', () => {
    expect(codexCompactionPolicy({ config: { model_context_window: 1_050_000 } })).toEqual({ provider: 'codex' })
  })
  it('preserves the explicit configuration and its counting scope', () => {
    expect(codexCompactionPolicy({ config: { model_auto_compact_token_limit: 630000, model_auto_compact_token_limit_scope: 'body_after_prefix' } }))
      .toEqual({ provider: 'codex', thresholdTokens: 630000, source: 'configuration', scope: 'body_after_prefix' })
  })
  it.each([0, -1, NaN, Infinity, '630000', 1.5])('rejects invalid thresholds: %s', threshold => {
    expect(codexCompactionPolicy({ config: { model_auto_compact_token_limit: threshold } })).toEqual({ provider: 'codex' })
  })
})
