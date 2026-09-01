import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, string>()
const continuityStateGet = vi.fn()
const continuityStateUpdate = vi.fn()

vi.mock('./crewcode-client', () => ({
  getCrewCodeRuntime: () => ({
    kind: 'web',
    client: { continuityStateGet, continuityStateUpdate },
  }),
}))

describe('continuity catalogue hydration', () => {
  beforeEach(() => {
    storage.clear()
    continuityStateGet.mockReset()
    continuityStateUpdate.mockReset()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
    vi.stubGlobal('window', {
      setInterval: () => 0,
      addEventListener: () => undefined,
    })
  })

  it('hydrates allowlisted Brain catalogue keys before React mounts', async () => {
    continuityStateGet.mockResolvedValue({
      version: 1,
      revision: 4,
      updatedAt: 1,
      values: {
        'crewcode:activeWorkspaceId': 'workspace-one',
        'crewcode:ignored': 'drop-me',
      },
    })
    const { hydrateContinuityState } = await import('./continuity-state')
    await hydrateContinuityState()
    expect(storage.get('crewcode:activeWorkspaceId')).toBe('workspace-one')
    expect(storage.has('crewcode:ignored')).toBe(false)
    expect(continuityStateUpdate).not.toHaveBeenCalled()
  })
})
