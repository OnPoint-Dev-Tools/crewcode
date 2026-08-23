import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderHook } from './hook-test-host'
import { FALLBACK_CATALOG, useProviderModels } from './useProviderModels'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useProviderModels browser fallback', () => {
  it('keeps dynamic-provider models visible while remote discovery is pending', async () => {
    let resolveModels!: (models: never[]) => void
    const pending = new Promise<never[]>(resolve => { resolveModels = resolve })
    vi.stubGlobal('window', { electronAPI: { agentListModels: vi.fn(() => pending) } })

    const hook = renderHook(useProviderModels, 'hermes')

    expect(hook.result.current.loading).toBe(true)
    expect(hook.result.current.list).toEqual(FALLBACK_CATALOG.hermes)

    await act(async () => {
      resolveModels([])
      await pending
    })
    expect(hook.result.current.list).toEqual(FALLBACK_CATALOG.hermes)

    hook.unmount()
  })

  it('has a usable browser fallback for every built-in dynamic provider', () => {
    for (const provider of ['pi', 'opencode', 'claude', 'hermes', 'crewcoder', 'grok', 'ollama', 'openrouter']) {
      expect(FALLBACK_CATALOG[provider]?.length, provider).toBeGreaterThan(0)
    }
  })
})
