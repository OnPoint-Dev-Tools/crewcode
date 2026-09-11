import { describe, expect, it } from 'vitest'
import { selectCodexRateLimits } from './codex-fetch'
import { sanitizeCodexCommandEnv } from './resolve-agent'

describe('Codex rate-limit response compatibility', () => {
  it('prefers the explicit codex bucket when provided', () => {
    const bucket = { primary: { usedPercent: 12 }, secondary: { usedPercent: 34 } }
    expect(selectCodexRateLimits({
      rateLimits: { primary: { usedPercent: 1 } },
      rateLimitsByLimitId: { codex: bucket },
    })).toBe(bucket)
  })

  it('falls back to the legacy single-bucket response', () => {
    const legacy = { primary: { usedPercent: 8 } }
    expect(selectCodexRateLimits({ rateLimits: legacy })).toBe(legacy)
  })
})

describe('Codex usage probe environment', () => {
  it('removes a parent managed Codex runtime identity', () => {
    expect(sanitizeCodexCommandEnv({
      PATH: '/usr/bin',
      CODEX_HOME: '/home/test/.crewcoder/codex-app-server',
      CODEX_THREAD_ID: 'thread-parent',
      CODEX_MANAGED_PACKAGE_ROOT: '/opt/crewcoder/node_modules/@openai/codex',
      CODEX_MANAGED_BY_NPM: '1',
      CODEX_CI: '1',
      CREWCODER_PROVIDER: 'codex',
      CREWCODER_MODEL: 'gpt-test',
    })).toEqual({ PATH: '/usr/bin' })
  })

  it('preserves an explicitly configured home outside a managed parent turn', () => {
    expect(sanitizeCodexCommandEnv({
      PATH: '/usr/bin',
      CODEX_HOME: '/home/test/.codex-work',
    })).toEqual({
      PATH: '/usr/bin',
      CODEX_HOME: '/home/test/.codex-work',
    })
  })
})
