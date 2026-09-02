import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('fs')
  vi.doUnmock('os')
  vi.resetModules()
})

describe('headless agent registry', () => {
  it('discovers Codex from Bun cache installs without a synchronous shell probe', async () => {
    const access = vi.fn(async (candidate: string) => {
      if (candidate === '/home/test/.cache/.bun/bin/codex') return
      throw new Error('missing')
    })
    vi.doMock('os', async importOriginal => ({
      ...await importOriginal<typeof import('os')>(),
      homedir: () => '/home/test',
    }))
    vi.doMock('fs', async importOriginal => {
      const actual = await importOriginal<typeof import('fs')>()
      return {
        ...actual,
        promises: { ...actual.promises, access },
      }
    })

    const { headlessAgentRegistry } = await import('./headless-agent-resolver')
    const registry = await headlessAgentRegistry()
    expect(registry.find(agent => agent.id === 'codex')).toMatchObject({
      available: true,
      path: '/home/test/.cache/.bun/bin/codex',
    })
  })

  it('lists models from the same provider CLIs as desktop', async () => {
    vi.doMock('./agents/model-detect', () => ({
      listModels: vi.fn(async (provider: string) => (
        provider === 'claude'
          ? [{ id: 'claude-sonnet-4-6', label: 'Sonnet', provider: 'anthropic' }]
          : []
      )),
    }))
    const { listHeadlessAgentModels } = await import('./headless-agent-resolver')
    expect(await listHeadlessAgentModels('claude')).toEqual([
      { id: 'claude-sonnet-4-6', label: 'Sonnet', provider: 'anthropic' },
    ])
    expect(await listHeadlessAgentModels('codex')).toEqual([])
  })
})
