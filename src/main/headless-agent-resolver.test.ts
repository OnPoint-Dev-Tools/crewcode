import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

function shellProbe(output = '', code = 0) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() })
  queueMicrotask(() => {
    child.stdout.end(output)
    child.emit('close', code)
  })
  return child
}

const spawn = vi.fn((_shell: string, _args: string[], _options: { detached?: boolean; timeout?: number }) => shellProbe())
const spawnSync = vi.fn((_shell: string, _args: string[], _options: { detached?: boolean; timeout?: number }) => ({ stdout: '', status: 0 }))

beforeEach(() => {
  spawn.mockReset()
  spawn.mockImplementation(() => shellProbe())
  spawnSync.mockClear()
  // Discovery tests must not execute the owner's login/interactive shell profiles.
  vi.doMock('child_process', async importOriginal => ({
    ...await importOriginal<typeof import('child_process')>(),
    spawn,
    spawnSync,
  }))
})

afterEach(() => {
  vi.doUnmock('child_process')
  vi.doUnmock('./agents/model-detect')
  vi.doUnmock('fs')
  vi.doUnmock('os')
  vi.resetModules()
})

describe('headless agent registry', () => {
  it('discovers Codex from Bun cache installs without a synchronous shell probe', async () => {
    const expectedPath = join('/home/test', '.cache', '.bun', 'bin', 'codex')
    const access = vi.fn(async (candidate: string) => {
      if (candidate === expectedPath) return
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
      path: expectedPath,
    })
    expect(spawnSync).not.toHaveBeenCalled()
    if (process.platform !== 'win32') {
      expect(spawn).toHaveBeenCalled()
      for (const [, , options] of spawn.mock.calls) {
        expect(options).toMatchObject({ detached: true, timeout: 3_000 })
      }
    }
  })

  it.skipIf(process.platform === 'win32')('retains interactive-shell discovery without caller terminal access', async () => {
    const expectedPath = join('/shell', 'codex')
    vi.doMock('fs', async importOriginal => {
      const actual = await importOriginal<typeof import('fs')>()
      return {
        ...actual,
        promises: { ...actual.promises, access: vi.fn(async (candidate: string) => {
          if (candidate !== expectedPath) throw new Error('missing')
        }) },
      }
    })
    spawn.mockImplementation((_shell, args) => shellProbe(
      args[0] === '-ic' && args[1] === 'command -v codex' ? `${expectedPath}\n` : '',
    ))

    const { headlessAgentRegistry } = await import('./headless-agent-resolver')
    const registry = await headlessAgentRegistry()
    expect(registry.find(agent => agent.id === 'codex')).toMatchObject({ available: true, path: expectedPath })
    expect(spawn).toHaveBeenCalledWith(expect.any(String), ['-ic', 'command -v codex'], expect.objectContaining({
      detached: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000,
    }))
  })

  it('lists models from the same provider CLIs as desktop', async () => {
    vi.doMock('fs', async importOriginal => ({
      ...await importOriginal<typeof import('fs')>(),
      existsSync: () => false,
    }))
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
    if (process.platform !== 'win32') {
      expect(spawnSync).toHaveBeenCalled()
      for (const [, , options] of spawnSync.mock.calls) {
        expect(options).toMatchObject({ detached: true, timeout: 3_000 })
      }
    }
  })
})
