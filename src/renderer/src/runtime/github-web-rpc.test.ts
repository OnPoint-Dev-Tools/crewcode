import { describe, expect, it, vi } from 'vitest'
import { createWebCrewCodeClient } from './web-rpc-client'

describe('GitHub pull request web RPC contract', () => {
  it('keeps review reads and mutations on the typed Brain transport', async () => {
    const rpc = vi.fn<(method: string, params: Record<string, unknown>) => void>()
    const client = createWebCrewCodeClient({
      rpc: async <T,>(method: string, params: Record<string, unknown>) => {
        rpc(method, params)
        return { ok: true } as T
      },
      subscribe: () => () => undefined,
    })

    await client.githubPrCreateContext('/repo', 'main')
    await client.githubPrDetail('/repo', 17)
    await client.githubPrDiff('/repo', 17)
    await client.ghPrReview('/repo', 17, { event: 'request-changes', body: 'Add coverage' })

    expect(rpc).toHaveBeenNthCalledWith(1, 'github.prCreateContext', { cwd: '/repo', base: 'main' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'github.prDetail', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(3, 'github.prDiff', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(4, 'gh.prReview', { cwd: '/repo', number: 17, options: { event: 'request-changes', body: 'Add coverage' } })
  })
})
