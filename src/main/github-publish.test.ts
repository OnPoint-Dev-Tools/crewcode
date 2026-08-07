import { describe, expect, it, vi } from 'vitest'
import { publishRepository, type PublishCommandRunner } from './github-publish'

const ok = (output = '') => ({ ok: true, output })
const fail = (error: string) => ({ ok: false, output: error, error })

describe('publishRepository', () => {
  it('initializes, commits, creates, and pushes a new repository', () => {
    const run = vi.fn<PublishCommandRunner>()
      .mockReturnValueOnce(fail('not a repository'))
      .mockReturnValueOnce(ok('initialized'))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(fail('no HEAD'))
      .mockReturnValueOnce(ok('committed'))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(fail('no origin'))
      .mockReturnValueOnce(ok('created'))
      .mockReturnValueOnce(ok('main'))
      .mockReturnValueOnce(ok('pushed'))

    expect(publishRepository({ name: 'demo', visibility: 'private' }, run).ok).toBe(true)
    expect(run.mock.calls).toEqual([
      ['git', ['rev-parse', '--is-inside-work-tree']],
      ['git', ['init']],
      ['git', ['add', '--all']],
      ['git', ['rev-parse', '--verify', 'HEAD']],
      ['git', ['commit', '--no-gpg-sign', '-m', 'Initial commit']],
      ['git', ['branch', '-M', 'main']],
      ['git', ['remote', 'get-url', 'origin']],
      ['gh', ['repo', 'create', 'demo', '--private', '--source', '.', '--remote', 'origin']],
      ['git', ['branch', '--show-current']],
      ['git', ['push', '-u', 'origin', 'main']],
    ])
  })

  it('resumes by pushing when a previous attempt already configured origin', () => {
    const run = vi.fn<PublishCommandRunner>()
      .mockReturnValueOnce(ok('true'))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok('abc123'))
      .mockReturnValueOnce(ok('https://github.com/user/demo.git'))
      .mockReturnValueOnce(ok('main'))
      .mockReturnValueOnce(ok('pushed'))

    expect(publishRepository({ name: 'demo', visibility: 'public' }, run).ok).toBe(true)
    expect(run.mock.calls.some(([command]) => command === 'gh')).toBe(false)
    expect(run).toHaveBeenLastCalledWith('git', ['push', '-u', 'origin', 'main'])
  })

  it('returns the failing push error', () => {
    const run = vi.fn<PublishCommandRunner>()
      .mockReturnValueOnce(ok('true'))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok('abc123'))
      .mockReturnValueOnce(ok('origin url'))
      .mockReturnValueOnce(ok('main'))
      .mockReturnValueOnce(fail('permission denied'))

    expect(publishRepository({ name: 'demo', visibility: 'private' }, run)).toMatchObject({
      ok: false,
      error: 'permission denied',
    })
  })
})
