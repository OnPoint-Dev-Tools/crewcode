import { describe, expect, it, vi } from 'vitest'

import { createPullRequest, getGhStatus, getGitHubAvatar, getGitHubStatus, getPullRequestCatalogue, getPullRequestCheckLog, getPullRequestChecksContext, getPullRequestCreateContext, getPullRequestDetail, getPullRequestDiff, getPullRequestManagementContext, getPullRequestReviewContext, preparePullRequestConflictResolution, pullRequestActionArgs, pullRequestCommentArgs, pullRequestCreateArgs, pullRequestEditArgs, pullRequestMergeArgs, pullRequestMetadataArgs, pullRequestReviewArgs, pullRequestReviewThreadArgs, pullRequestViewedFileArgs, rerunPullRequestCheck, submitPullRequestReview, updatePullRequestMergeAutomation, updatePullRequestReviewThread, updatePullRequestViewedFile, type GitHubCommandRunner, type GitHubInputCommandRunner } from './github-service'

function result(stdout = '', status = 0, stderr = '') {
  return { status, stdout, stderr }
}

describe('non-blocking GitHub status', () => {
  it('fetches a bounded GitHub avatar and returns only a data URL', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    }))

    await expect(getGitHubAvatar('/repo', 'avatar-test-user', fetcher)).resolves.toEqual({
      ok: true,
      dataUrl: 'data:image/png;base64,AQID',
    })
    expect(fetcher).toHaveBeenCalledWith(new URL('https://github.com/avatar-test-user.png?size=64'), expect.objectContaining({ redirect: 'manual' }))
  })

  it('rejects unsafe avatar usernames, redirects, and oversized images', async () => {
    const invalidFetcher = vi.fn(async () => new Response())
    await expect(getGitHubAvatar('/repo', '../settings', invalidFetcher)).resolves.toEqual({ ok: false, error: 'Invalid GitHub username' })
    expect(invalidFetcher).not.toHaveBeenCalled()

    const redirectFetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/avatar.png' } }))
    await expect(getGitHubAvatar('/repo', 'unsafe-redirect-user', redirectFetcher)).resolves.toEqual({ ok: false, error: 'GitHub returned an unsupported avatar location' })
    expect(redirectFetcher).toHaveBeenCalledTimes(1)

    const oversizedFetcher = vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(256 * 1024 + 1) },
    }))
    await expect(getGitHubAvatar('/repo', 'oversized-avatar-user', oversizedFetcher)).resolves.toEqual({ ok: false, error: 'GitHub avatar image is too large' })

    const streamedOversizedFetcher = vi.fn(async () => new Response(new Uint8Array(256 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    await expect(getGitHubAvatar('/repo', 'streamed-oversized-user', streamedOversizedFetcher)).resolves.toEqual({ ok: false, error: 'GitHub avatar image is too large' })
  })

  it('collects repository status through the async command runner', async () => {
    const run: GitHubCommandRunner = vi.fn(async (command, args) => {
      const key = `${command} ${args.slice(0, 2).join(' ')}`
      if (key === 'git remote get-url') return result('git@github.com:crewcode/app.git\n')
      if (key === 'gh pr list') return result('[{"number":7,"title":"Fix","headRefName":"fix","baseRefName":"dev","state":"OPEN","url":"https://github.com/crewcode/app/pull/7","isDraft":false,"author":{"login":"CjLogix"},"updatedAt":"2026-08-28T20:00:00Z","body":"Fixes CI","mergeStateStatus":"BEHIND","reviewDecision":"REVIEW_REQUIRED"}]')
      if (key === 'gh run list') return result('[{"databaseId":9,"name":"test","status":"completed","conclusion":"success","headBranch":"fix"}]')
      if (key === 'gh issue list') return result('[{"number":1},{"number":2}]')
      return result('gh version 1')
    })

    await expect(getGitHubStatus('/repo', run)).resolves.toEqual({
      owner: 'crewcode',
      repo: 'app',
      prs: [{
        number: 7, title: 'Fix', state: 'OPEN', branch: 'fix', base: 'dev',
        url: 'https://github.com/crewcode/app/pull/7', isDraft: false, author: 'CjLogix',
        updatedAt: '2026-08-28T20:00:00Z', body: 'Fixes CI', mergeStateStatus: 'BEHIND',
        reviewDecision: 'REVIEW_REQUIRED',
      }],
      runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', branch: 'fix' }],
      issues: 2,
    })
  })

  it('builds explicit create and merge commands without browser handoff', () => {
    expect(pullRequestCreateArgs({ title: ' Fix CI ', body: ' Verified ', base: 'dev', draft: true })).toEqual([
      'pr', 'create', '--title', 'Fix CI', '--base', 'dev', '--body', 'Verified', '--draft',
    ])
    expect(pullRequestCreateArgs({ title: 'Selected fix', base: 'main', draft: false, selectedBranch: 'pr/selected-fix' })).toContain('pr/selected-fix')
    expect(pullRequestMergeArgs(7, 'merge')).toEqual(['pr', 'merge', '7', '--merge'])
    expect(pullRequestMergeArgs(7, 'squash')).toEqual(['pr', 'merge', '7', '--squash'])
    expect(pullRequestMergeArgs(7, 'rebase')).toEqual(['pr', 'merge', '7', '--rebase'])
    expect(pullRequestMergeArgs(7, 'squash', 'abcdef1')).toEqual(['pr', 'merge', '7', '--squash', '--match-head-commit', 'abcdef1'])
    expect(pullRequestActionArgs('ready', 7)).toEqual(['pr', 'ready', '7'])
    expect(pullRequestActionArgs('draft', 7)).toEqual(['pr', 'ready', '7', '--undo'])
    expect(pullRequestActionArgs('reopen', 7)).toEqual(['pr', 'reopen', '7'])
    expect(pullRequestActionArgs('update-branch', 7)).toEqual(['pr', 'update-branch', '7'])
    expect(pullRequestEditArgs(7, { title: ' Updated title ', body: '## Problem\nDetails' })).toEqual(['pr', 'edit', '7', '--title', 'Updated title', '--body', '## Problem\nDetails'])
    expect(pullRequestMetadataArgs(7, { kind: 'reviewer', operation: 'add', value: 'CjLogix' })).toEqual(['pr', 'edit', '7', '--add-reviewer', 'CjLogix'])
    expect(pullRequestMetadataArgs(7, { kind: 'label', operation: 'remove', value: 'release' })).toEqual(['pr', 'edit', '7', '--remove-label', 'release'])
    expect(() => pullRequestMetadataArgs(7, { kind: 'label', operation: 'add', value: 'one,two' })).toThrow('Invalid pull request label')
    expect(pullRequestCommentArgs(7, ' Looks good ')).toEqual(['pr', 'comment', '7', '--body', 'Looks good'])
    expect(() => pullRequestCommentArgs(7, ' ')).toThrow('Comment is required')
    expect(pullRequestReviewArgs(7, { event: 'approve', body: 'Ship it' })).toEqual(['pr', 'review', '7', '--approve', '--body', 'Ship it'])
    expect(pullRequestReviewArgs(7, { event: 'request-changes', body: 'Please add coverage' })).toEqual(['pr', 'review', '7', '--request-changes', '--body', 'Please add coverage'])
    expect(() => pullRequestReviewArgs(7, { event: 'comment' })).toThrow('Review comment is required')
    expect(() => pullRequestMergeArgs(7, 'invalid' as 'merge')).toThrow('Unsupported pull request merge method')
  })

  it('builds exact GitHub viewed-file and review-thread mutations', () => {
    expect(pullRequestViewedFileArgs({ pullRequestId: 'PR_7', path: 'src/a.ts', viewed: true })).toEqual(expect.arrayContaining(['pullRequestId=PR_7', 'path=src/a.ts']))
    expect(pullRequestViewedFileArgs({ pullRequestId: 'PR_7', path: 'src/a.ts', viewed: true }).join(' ')).toContain('markFileAsViewed')
    expect(pullRequestViewedFileArgs({ pullRequestId: 'PR_7', path: 'src/a.ts', viewed: false }).join(' ')).toContain('unmarkFileAsViewed')
    expect(pullRequestReviewThreadArgs('THREAD_1', true).join(' ')).toContain('resolveReviewThread')
    expect(pullRequestReviewThreadArgs('THREAD_1', false).join(' ')).toContain('unresolveReviewThread')
  })

  it('loads bounded inline threads, viewed files, and changes since the viewer review', async () => {
    const graph = { data: { viewer: { login: 'cj' }, repository: { pullRequest: {
      id: 'PR_7', headRefOid: 'bbbbbbb',
      files: { nodes: [{ path: 'src/a.ts', viewerViewedState: 'VIEWED' }, { path: 'src/b.ts', viewerViewedState: 'UNVIEWED' }] },
      reviews: { nodes: [{ author: { login: 'cj' }, state: 'COMMENTED', submittedAt: '2026-09-01T10:00:00Z', commit: { oid: 'aaaaaaa' } }] },
      reviewThreads: { nodes: [{
        id: 'THREAD_1', path: 'src/a.ts', diffSide: 'RIGHT', line: 12, startLine: null,
        isResolved: false, isOutdated: false, resolvedBy: null, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: false,
        comments: { nodes: [{ id: 'COMMENT_1', databaseId: 41, author: { login: 'lead' }, body: 'Please rename this.', createdAt: '2026-09-01T11:00:00Z', commit: { oid: 'bbbbbbb' }, pullRequestReview: { state: 'COMMENTED' } }] },
      }] },
    } } } }
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === 'repo') return result('owner/repo\n')
      if (args.includes('graphql')) return result(JSON.stringify(graph))
      if (String(args[1]).includes('/compare/')) return result(JSON.stringify({ files: [{ filename: 'src/b.ts' }], commits: [{ sha: 'bbbbbbb', commit: { message: 'Follow-up\nbody' } }] }))
      return result('', 1, 'unexpected')
    })
    await expect(getPullRequestReviewContext('/repo', 7, run)).resolves.toMatchObject({
      pullRequestId: 'PR_7', headCommitId: 'bbbbbbb', viewer: 'cj',
      files: [{ path: 'src/a.ts', viewed: true }, { path: 'src/b.ts', viewed: false }],
      threads: [expect.objectContaining({ id: 'THREAD_1', path: 'src/a.ts', line: 12, viewerCanResolve: true })],
      lastReviewedCommitId: 'aaaaaaa', filesSinceLastReview: ['src/b.ts'],
      commitsSinceLastReview: [{ oid: 'bbbbbbb', message: 'Follow-up' }],
    })
  })

  it('loads bounded management choices for the exact repository pull request', async () => {
    const graph = { data: { repository: {
      assignableUsers: { nodes: [{ login: 'cj' }, { login: 'lead' }] },
      labels: { nodes: [{ name: 'bug' }, { name: 'release' }] },
      pullRequest: { suggestedReviewers: [{ reviewer: { login: 'lead' } }] },
    } } }
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === 'repo') return result('owner/repo\n')
      if (args.includes('graphql')) return result(JSON.stringify(graph))
      return result('', 1, 'unexpected')
    })
    await expect(getPullRequestManagementContext('/repo', 7, run)).resolves.toEqual({
      assignableUsers: ['cj', 'lead'], suggestedReviewers: ['lead'], labels: ['bug', 'release'],
    })
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['owner=owner', 'repo=repo', 'number=7']), '/repo')
  })

  it('loads detailed check jobs, steps, annotations, and merge capabilities', async () => {
    const graph: any = { data: { repository: { viewerPermission: 'WRITE', pullRequest: {
      headRefOid: 'abcdef1', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
      isMergeQueueEnabled: false, isInMergeQueue: false, viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: false,
      viewerCanUpdateBranch: true, viewerCannotUpdateReasons: [], autoMergeRequest: null, mergeQueueEntry: null,
      statusCheckRollup: { contexts: { nodes: [{
        __typename: 'CheckRun', id: 'CR_1', databaseId: 22, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true,
        detailsUrl: 'https://ci.example', permalink: 'https://github.com/o/r/runs/22', startedAt: '2026-09-03T10:00:00Z', completedAt: '2026-09-03T10:01:00Z', title: 'Tests failed', summary: 'One failed', text: '',
        steps: { nodes: [{ name: 'npm test', number: 2, status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '', completedAt: '' }], pageInfo: { hasNextPage: false } },
        annotations: { nodes: [{ annotationLevel: 'FAILURE', path: 'src/a.ts', title: 'Error', message: 'Expected true', rawDetails: 'line 1', blobUrl: 'https://github.com/o/r/blob/a/src/a.ts', location: { start: { line: 17, column: 2 }, end: { line: 18, column: 8 } } }], pageInfo: { hasNextPage: false } },
        checkSuite: { app: { name: 'GitHub Actions' }, workflowRun: { databaseId: 11, runAttempt: 2, url: 'https://github.com/o/r/actions/runs/11', workflow: { name: 'CI' } } },
      }] } },
    } } } }
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => args[0] === 'repo' ? result('o/r\n') : result(JSON.stringify(graph)))
    await expect(getPullRequestChecksContext('/repo', 7, run)).resolves.toMatchObject({
      headCommitId: 'abcdef1', viewerCanRerunChecks: true, viewerCanEnableAutoMerge: true, reviewDecision: 'REVIEW_REQUIRED',
      checks: [{ id: 'CR_1', name: 'test', suiteName: 'CI', isRequired: true, runId: 11, runAttempt: 2, jobId: 22,
        steps: [{ name: 'npm test', conclusion: 'FAILURE' }], annotations: [{ path: 'src/a.ts', startLine: 17, endLine: 18, message: 'Expected true' }] }],
    })
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining([
      expect.stringContaining('isRequired(pullRequestNumber:$number)'),
    ]), '/repo')

    const logRun: GitHubCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === 'repo') return result('o/r\n')
      if (args.includes('graphql')) return result(JSON.stringify(graph))
      if (args[0] === 'run' && args[1] === 'view') return result('\u001b[31mfailed\u001b[0m\n')
      return result('', 1, 'unexpected')
    })
    await expect(getPullRequestCheckLog('/repo', 7, 'abcdef1', 11, 22, logRun)).resolves.toEqual({ ok: true, log: 'failed\n', truncated: false })
    await expect(getPullRequestCheckLog('/repo', 7, 'abcdef1', 11, 99, logRun)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not belong') })

    const rerun = vi.fn<GitHubCommandRunner>(async (_command, args) => {
      if (args[0] === 'repo') return result('o/r\n')
      if (args.includes('graphql')) return result(JSON.stringify(graph))
      return result('accepted')
    })
    await expect(rerunPullRequestCheck('/repo', 7, { headCommitId: 'abcdef1', runId: 11, mode: 'job', jobId: 22 }, rerun)).resolves.toMatchObject({ ok: true })
    expect(rerun).toHaveBeenCalledWith('gh', ['run', 'rerun', '11', '--job', '22'], '/repo')
    await expect(rerunPullRequestCheck('/repo', 7, { headCommitId: 'deadbee', runId: 11, mode: 'failed' }, rerun)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('head changed') })

    const automation = vi.fn<GitHubCommandRunner>(async (_command, args) => {
      if (args[0] === 'repo') return result('o/r\n')
      if (args.includes('graphql')) return result(JSON.stringify(graph))
      return result('accepted')
    })
    await expect(updatePullRequestMergeAutomation('/repo', 7, { action: 'enable', headCommitId: 'abcdef1', method: 'squash' }, automation)).resolves.toMatchObject({ ok: true })
    expect(automation).toHaveBeenCalledWith('gh', ['pr', 'merge', '7', '--auto', '--squash', '--match-head-commit', 'abcdef1'], '/repo')

    graph.data.repository.pullRequest.viewerCanEnableAutoMerge = false
    graph.data.repository.pullRequest.viewerCanDisableAutoMerge = true
    graph.data.repository.pullRequest.autoMergeRequest = { enabledAt: '2026-09-03T10:02:00Z', enabledBy: { login: 'cj' }, mergeMethod: 'SQUASH' }
    await expect(updatePullRequestMergeAutomation('/repo', 7, { action: 'disable', headCommitId: 'abcdef1' }, automation)).resolves.toMatchObject({ ok: true })
    expect(automation).toHaveBeenCalledWith('gh', ['pr', 'merge', '7', '--disable-auto', '--match-head-commit', 'abcdef1'], '/repo')

    graph.data.repository.pullRequest.viewerCanDisableAutoMerge = false
    graph.data.repository.pullRequest.isMergeQueueEnabled = true
    graph.data.repository.pullRequest.autoMergeRequest = null
    await expect(updatePullRequestMergeAutomation('/repo', 7, { action: 'queue', headCommitId: 'abcdef1' }, automation)).resolves.toMatchObject({ ok: true })
    expect(automation).toHaveBeenCalledWith('gh', ['pr', 'merge', '7', '--match-head-commit', 'abcdef1'], '/repo')
  })

  it('submits a multi-comment review only after revalidating the exact head commit', async () => {
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === 'repo') return result('owner/repo\n')
      if (args[0] === 'pr' && args[1] === 'view') return result('abcdef1\n')
      return result('', 1, 'unexpected')
    })
    const runInput: GitHubInputCommandRunner = vi.fn(async () => result('{"id":9}'))
    const options = {
      event: 'request-changes' as const, body: 'Please address the notes.', commitId: 'abcdef1',
      comments: [
        { id: 'local-1', path: 'src/a.ts', side: 'RIGHT' as const, line: 12, body: 'Rename this.', commitId: 'abcdef1' },
        { id: 'local-2', path: 'src/b.ts', side: 'LEFT' as const, line: 4, body: 'Keep this branch.', commitId: 'abcdef1' },
      ],
    }
    await expect(submitPullRequestReview('/repo', 7, options, run, runInput)).resolves.toMatchObject({ ok: true })
    expect(runInput).toHaveBeenCalledWith('gh', ['api', '--method', 'POST', 'repos/owner/repo/pulls/7/reviews', '--input', '-'], expect.any(String), '/repo')
    const payload = JSON.parse(vi.mocked(runInput).mock.calls[0][2])
    expect(payload).toMatchObject({ event: 'REQUEST_CHANGES', commit_id: 'abcdef1', comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Rename this.' }, { path: 'src/b.ts', line: 4, side: 'LEFT', body: 'Keep this branch.' }] })

    const staleRun: GitHubCommandRunner = vi.fn(async (_command, args) => args[0] === 'repo' ? result('owner/repo\n') : result('different1\n'))
    await expect(submitPullRequestReview('/repo', 7, options, staleRun, runInput)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('changed after') })
  })

  it('refuses file and thread node ids that are not observed on the selected pull request', async () => {
    const graph = { data: { viewer: { login: 'cj' }, repository: { pullRequest: {
      id: 'PR_7', headRefOid: 'abcdef1', files: { nodes: [{ path: 'src/a.ts', viewerViewedState: 'UNVIEWED' }] }, reviews: { nodes: [] },
      reviewThreads: { nodes: [{ id: 'THREAD_1', path: 'src/a.ts', diffSide: 'RIGHT', line: 2, startLine: null, isResolved: false, isOutdated: false, resolvedBy: null, viewerCanReply: true, viewerCanResolve: false, viewerCanUnresolve: false, comments: { nodes: [] } }] },
    } } } }
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === 'repo') return result('owner/repo\n')
      if (args.includes('graphql')) return result(JSON.stringify(graph))
      return result('{}')
    })
    await expect(updatePullRequestViewedFile('/repo', 7, { pullRequestId: 'OTHER_PR', path: 'src/a.ts', viewed: true }, run)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not belong') })
    await expect(updatePullRequestViewedFile('/repo', 7, { pullRequestId: 'PR_7', path: 'src/other.ts', viewed: true }, run)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not belong') })
    await expect(updatePullRequestReviewThread('/repo', 7, 'OTHER_THREAD', true, run)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not belong') })
    await expect(updatePullRequestReviewThread('/repo', 7, 'THREAD_1', true, run)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not allow') })
    expect(run).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['pullRequestId=OTHER_PR']), '/repo')
  })

  it('measures creation context against the selected base without mutating refs', async () => {
    const run: GitHubCommandRunner = vi.fn(async (command, args) => {
      if (command !== 'git') return result('', 1)
      if (args[0] === 'branch') return result('feature\n')
      if (args[0] === 'rev-list') return result('2\t4\n')
      if (args[0] === 'diff') return result('src/a.ts\nsrc/b.ts\n')
      if (args[0] === 'merge-base') return result('abc123\n')
      if (args[0] === 'merge-tree') return result('merged cleanly\n')
      if (args[0] === 'log') return result('0123456789012345678901234567890123456789\x1fFix one\x1fCJ\x1f2026-09-03T12:00:00Z\n')
      return result('', 1)
    })

    await expect(getPullRequestCreateContext('/repo', 'main', run)).resolves.toEqual({
      head: 'feature', base: 'main', ahead: 4, behind: 2, changedFiles: 2, mergeStatus: 'clean',
      commits: [{ oid: '0123456789012345678901234567890123456789', title: 'Fix one', author: 'CJ', committedAt: '2026-09-03T12:00:00Z' }],
    })
    expect(run).toHaveBeenCalledWith('git', ['merge-tree', 'abc123', 'main', 'HEAD'], '/repo')
  })

  it('creates a selected-commit PR from an isolated latest-base worktree', async () => {
    const oid = '0123456789012345678901234567890123456789'
    const run: GitHubCommandRunner = vi.fn(async (command, args) => {
      if (command === 'gh') return result('https://github.com/crewcode/app/pull/8\n')
      if (args[0] === 'fetch') return result('fetched\n')
      if (args[0] === 'rev-list') return result(`${oid}\n`)
      if (args[0] === 'show-ref') return result('', 1)
      if (args[0] === 'ls-remote') return result('', 2)
      return result('ok\n')
    })

    await expect(createPullRequest('/repo', {
      title: 'Selected fix', base: 'main', draft: false,
      selectedCommits: [oid], selectedBranch: 'pr/selected-fix',
    }, run)).resolves.toEqual({ ok: true, output: 'https://github.com/crewcode/app/pull/8' })
    expect(run).toHaveBeenCalledWith('git', ['fetch', 'origin', 'main'], '/repo')
    expect(run).toHaveBeenCalledWith('git', ['rev-list', '--reverse', 'origin/main..HEAD'], '/repo')
    expect(run).toHaveBeenCalledWith('git', ['cherry-pick', oid], expect.stringContaining('crewcode-pr-'))
    expect(run).toHaveBeenCalledWith('git', ['push', '--set-upstream', 'origin', 'pr/selected-fix'], expect.stringContaining('crewcode-pr-'))
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['pr', 'create', '--head', 'pr/selected-fix']), '/repo')
  })

  it('starts PR conflict resolution only from the clean expected head worktree', async () => {
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => {
      const key = args.join(' ')
      if (key === 'branch --show-current') return result('dev\n')
      if (key === 'rev-parse -q --verify MERGE_HEAD') return result('', 1)
      if (key === 'status --porcelain') return result('')
      if (key === 'fetch origin main') return result('fetched\n')
      if (key === 'merge --no-edit origin/main') return result('', 1, 'Automatic merge failed; fix conflicts and commit the result.\n')
      if (key === 'diff --name-only --diff-filter=U') return result('src/a.ts\nsrc/b.ts\n')
      return result('', 1, `unexpected: ${key}`)
    })

    await expect(preparePullRequestConflictResolution('/repo', 'dev', 'main', run)).resolves.toEqual({
      ok: true,
      status: 'conflicts',
      conflicts: ['src/a.ts', 'src/b.ts'],
      output: 'Automatic merge failed; fix conflicts and commit the result.',
    })
    expect(run).toHaveBeenCalledWith('git', ['fetch', 'origin', 'main'], '/repo')
    expect(run).toHaveBeenCalledWith('git', ['merge', '--no-edit', 'origin/main'], '/repo')
  })

  it('refuses PR conflict resolution in a different or dirty worktree', async () => {
    const wrongBranch: GitHubCommandRunner = vi.fn(async () => result('feature\n'))
    await expect(preparePullRequestConflictResolution('/repo', 'dev', 'main', wrongBranch)).resolves.toMatchObject({
      ok: false,
      error: 'Conflict resolution must run in the dev worktree; this worktree is on feature',
    })
    expect(wrongBranch).toHaveBeenCalledTimes(1)

    const dirty: GitHubCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === 'branch') return result('dev\n')
      if (args[0] === 'rev-parse') return result('', 1)
      if (args[0] === 'status') return result(' M src/a.ts\n')
      return result('', 1)
    })
    await expect(preparePullRequestConflictResolution('/repo', 'dev', 'main', dirty)).resolves.toMatchObject({
      ok: false,
      error: 'The dev worktree has uncommitted changes. Commit, stash, or discard them before starting conflict resolution.',
    })
    expect(dirty).not.toHaveBeenCalledWith('git', ['fetch', 'origin', 'main'], '/repo')
  })

  it('loads normalized review evidence and the real pull-request patch', async () => {
    const payload = {
      number: 7, title: 'Fix CI', state: 'OPEN', url: 'https://github.com/o/r/pull/7', isDraft: false,
      author: { login: 'cj' }, body: 'Details', headRefName: 'fix', headRefOid: 'abcdef123', baseRefName: 'main', createdAt: '2026-08-28T19:30:00Z', updatedAt: '2026-08-28T22:30:00Z', mergeStateStatus: 'CLEAN',
      reviewDecision: 'REVIEW_REQUIRED', additions: 8, deletions: 3,
      files: [{ path: 'src/a.ts', additions: 8, deletions: 3 }],
      commits: [{ oid: 'abcdef123', messageHeadline: 'Fix it', committedDate: '2026-08-28T20:00:00Z', authors: [{ login: 'cj' }] }],
      comments: [{ id: 'c1', author: { login: 'reviewer' }, body: 'Question', createdAt: '2026-08-28T21:00:00Z' }],
      reviews: [{ id: 'r1', author: { login: 'lead' }, body: 'Looks close', state: 'COMMENTED', submittedAt: '2026-08-28T22:00:00Z' }],
      reviewRequests: [{ login: 'pending-reviewer' }], assignees: [{ login: 'owner' }], labels: [{ name: 'release' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/check' }],
    }
    const patch = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => args[1] === 'view' ? result(JSON.stringify(payload)) : result(patch))

    await expect(getPullRequestDetail('/repo', 7, run)).resolves.toMatchObject({
      number: 7, head: 'fix', base: 'main', headCommitId: 'abcdef123', createdAt: '2026-08-28T19:30:00Z', updatedAt: '2026-08-28T22:30:00Z', additions: 8, deletions: 3,
      files: [{ path: 'src/a.ts', additions: 8, deletions: 3 }],
      commits: [{ oid: 'abcdef123', message: 'Fix it', author: 'cj' }],
      comments: [expect.objectContaining({ id: 'c1', kind: 'comment' }), expect.objectContaining({ id: 'r1', kind: 'review', state: 'COMMENTED' })],
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/check' }],
      assignees: ['owner'], reviewers: [{ login: 'pending-reviewer', state: 'REQUESTED' }, { login: 'lead', state: 'COMMENTED' }], labels: ['release'],
    })
    await expect(getPullRequestDiff('/repo', 7, run)).resolves.toEqual({ ok: true, patch })
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'diff', '7'], '/repo')
  })

  it('loads one repository PR catalogue with viewer assignment evidence', async () => {
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => args[0] === 'pr'
      ? result(JSON.stringify([{
          number: 12, title: 'Release', state: 'OPEN', url: 'https://github.com/o/r/pull/12', isDraft: false,
          author: { login: 'cj' }, body: '## Problem\nSlow startup', headRefName: 'dev', baseRefName: 'main', createdAt: '2026-09-02T11:00:00Z', updatedAt: '2026-09-02T12:00:00Z', reviewDecision: 'REVIEW_REQUIRED',
          assignees: [{ login: 'CjLogix' }], reviewRequests: [{ login: 'lead' }], labels: [{ name: 'release' }],
        }]))
      : result('', 0, 'Logged in to github.com as CjLogix'))

    await expect(getPullRequestCatalogue('/repo', run)).resolves.toEqual({
      viewer: 'CjLogix',
      items: [expect.objectContaining({ number: 12, head: 'dev', base: 'main', createdAt: '2026-09-02T11:00:00Z', reviewDecision: 'REVIEW_REQUIRED', assignees: ['CjLogix'], reviewers: ['lead'], labels: ['release'] })],
    })
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '--state', 'all', '--limit', '100', '--json', expect.stringContaining('reviewRequests')], '/repo')
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '--state', 'all', '--limit', '100', '--json', expect.stringContaining('createdAt')], '/repo')
  })

  it('reports gh authentication without synchronous process calls', async () => {
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => args[0] === '--version'
      ? result('gh version 1')
      : result('', 0, 'Logged in to github.com as CjLogix'))

    await expect(getGhStatus(run)).resolves.toMatchObject({
      available: true,
      loggedIn: true,
      user: 'CjLogix',
      host: 'github.com',
    })
  })
})
