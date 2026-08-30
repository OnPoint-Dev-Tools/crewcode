import { describe, expect, it, vi } from 'vitest'
import { discardPath } from './git-discard'

describe('discardPath', () => {
  it('restores tracked changes including the index', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await discardPath('src/file.ts', run)
    expect(run).toHaveBeenCalledWith(['restore', '--source=HEAD', '--staged', '--worktree', '--', 'src/file.ts'])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('removes an added file when there is no HEAD version', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('path is not in HEAD'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await discardPath('new.ts', run)
    expect(run).toHaveBeenNthCalledWith(2, ['rm', '--force', '--cached', '--', 'new.ts'])
    expect(run).toHaveBeenNthCalledWith(3, ['clean', '--force', '--', 'new.ts'])
  })
})
