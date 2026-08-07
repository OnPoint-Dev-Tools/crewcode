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
})
