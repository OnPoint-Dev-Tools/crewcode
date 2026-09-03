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
    await client.githubPrCatalogue('/repo')
    await client.githubPrDetail('/repo', 17)
    await client.githubPrDiff('/repo', 17)
    await client.githubPrReviewContext('/repo', 17)
    await client.githubPrManagementContext('/repo', 17)
    await client.githubAvatar('/repo', 'CjLogix')
    await client.ghPrReady('/repo', 17)
    await client.ghPrDraft('/repo', 17)
    await client.ghPrReopen('/repo', 17)
    await client.ghPrEdit('/repo', 17, { title: 'New title', body: 'New body' })
    await client.ghPrMetadata('/repo', 17, { kind: 'label', operation: 'add', value: 'bug' })
    await client.ghPrPrepareConflictResolution('/repo', 'dev', 'main')
    await client.ghPrReview('/repo', 17, { event: 'request-changes', body: 'Add coverage' })
    await client.ghPrViewedFile('/repo', 17, { pullRequestId: 'PR_17', path: 'src/a.ts', viewed: true })
    await client.ghPrReviewThread('/repo', 17, 'THREAD_1', true)
    await client.githubPrChecksContext('/repo', 17)
    await client.githubPrCheckLog('/repo', 17, 'abcdef1', 11, 22)
    await client.ghPrMerge('/repo', 17, 'squash', 'abcdef1')
    await client.ghPrCheckRerun('/repo', 17, { headCommitId: 'abcdef1', runId: 11, mode: 'job', jobId: 22 })
    await client.ghPrMergeAutomation('/repo', 17, { action: 'enable', headCommitId: 'abcdef1', method: 'squash' })

    expect(rpc).toHaveBeenNthCalledWith(1, 'github.prCreateContext', { cwd: '/repo', base: 'main' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'github.prCatalogue', { cwd: '/repo' })
    expect(rpc).toHaveBeenNthCalledWith(3, 'github.prDetail', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(4, 'github.prDiff', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(5, 'github.prReviewContext', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(6, 'github.prManagementContext', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(7, 'github.avatar', { cwd: '/repo', login: 'CjLogix' })
    expect(rpc).toHaveBeenNthCalledWith(8, 'gh.prReady', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(9, 'gh.prDraft', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(10, 'gh.prReopen', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenNthCalledWith(11, 'gh.prEdit', { cwd: '/repo', number: 17, options: { title: 'New title', body: 'New body' } })
    expect(rpc).toHaveBeenNthCalledWith(12, 'gh.prMetadata', { cwd: '/repo', number: 17, options: { kind: 'label', operation: 'add', value: 'bug' } })
    expect(rpc).toHaveBeenNthCalledWith(13, 'gh.prPrepareConflictResolution', { cwd: '/repo', head: 'dev', base: 'main' })
    expect(rpc).toHaveBeenNthCalledWith(14, 'gh.prReview', { cwd: '/repo', number: 17, options: { event: 'request-changes', body: 'Add coverage' } })
    expect(rpc).toHaveBeenNthCalledWith(15, 'gh.prViewedFile', { cwd: '/repo', number: 17, options: { pullRequestId: 'PR_17', path: 'src/a.ts', viewed: true } })
    expect(rpc).toHaveBeenNthCalledWith(16, 'gh.prReviewThread', { cwd: '/repo', number: 17, threadId: 'THREAD_1', resolved: true })
    expect(rpc).toHaveBeenCalledWith('github.prChecksContext', { cwd: '/repo', number: 17 })
    expect(rpc).toHaveBeenCalledWith('github.prCheckLog', { cwd: '/repo', number: 17, headCommitId: 'abcdef1', runId: 11, jobId: 22 })
    expect(rpc).toHaveBeenCalledWith('gh.prMerge', { cwd: '/repo', number: 17, method: 'squash', headCommitId: 'abcdef1' })
    expect(rpc).toHaveBeenCalledWith('gh.prCheckRerun', { cwd: '/repo', number: 17, options: { headCommitId: 'abcdef1', runId: 11, mode: 'job', jobId: 22 } })
    expect(rpc).toHaveBeenCalledWith('gh.prMergeAutomation', { cwd: '/repo', number: 17, options: { action: 'enable', headCommitId: 'abcdef1', method: 'squash' } })
  })
})
