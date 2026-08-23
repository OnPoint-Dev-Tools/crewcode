import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AgentBridgeService } from './bridge-service'

describe('AgentBridgeService', () => {
  it('rejects unknown and plugin providers before resolving a path', async () => {
    const resolvePath = vi.fn(() => '/bin/agent')
    const service = new AgentBridgeService(resolvePath)
    await expect(service.start({ bridgeId: 'unknown', provider: 'plugin:test', cwd: '/tmp' })).resolves.toEqual({ error: 'agent provider is not available over remote access' })
    expect(resolvePath).not.toHaveBeenCalled()
  })

  it('reports missing local provider binaries without starting a bridge', async () => {
    const service = new AgentBridgeService(() => null)
    await expect(service.start({ bridgeId: 'codex', provider: 'codex', cwd: '/tmp' })).resolves.toEqual({ error: 'codex not found on this machine' })
  })

  it('returns bounded lifecycle results for absent bridges', async () => {
    const service = new AgentBridgeService(() => null)
    await expect(service.prompt('missing', 'hello')).resolves.toEqual({ ok: false, error: 'bridge not found' })
    await expect(service.abort('missing')).resolves.toEqual({ ok: true })
    await expect(service.stop('missing')).resolves.toEqual({ ok: true })
  })

  it('treats a duplicate stable start as an attach without stopping the provider', async () => {
    const service = new AgentBridgeService(() => null)
    const stop = vi.spyOn(service, 'stop')
    const opts = { bridgeId: 'stable-web-bridge', provider: 'ollama' as const, cwd: '/tmp', model: 'test-model' }
    const dataDir = mkdtempSync(join(tmpdir(), 'crewcode-bridge-service-'))
    const previousDataDir = process.env.CREWCODE_DATA_DIR
    process.env.CREWCODE_DATA_DIR = dataDir

    try {
      await expect(service.start(opts)).resolves.toEqual({ ok: true })
      expect(stop).toHaveBeenCalledTimes(1)
      await expect(service.start(opts)).resolves.toEqual({ ok: true })
      expect(stop).toHaveBeenCalledTimes(1)
      await expect(service.start({ ...opts, model: 'different-model' })).resolves.toEqual({
        error: 'bridge already exists with different execution configuration; stop it before restarting',
      })
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      await service.stop(opts.bridgeId)
      if (previousDataDir === undefined) delete process.env.CREWCODE_DATA_DIR
      else process.env.CREWCODE_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
