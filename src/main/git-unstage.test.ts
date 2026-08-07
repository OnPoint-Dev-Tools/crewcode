import { describe, expect, it, vi } from 'vitest'
import { unstagePaths } from './git-unstage'

describe('unstagePaths', () => {
  it('uses restore when HEAD exists', async () => {
    const run = vi.fn().mockResolvedValue({})

    await unstagePaths(['src/a.ts', 'src/b.ts'], run)

    expect(run.mock.calls).toEqual([
      [['rev-parse', '--verify', 'HEAD']],
      [['restore', '--staged', '--', 'src/a.ts', 'src/b.ts']],
    ])
  })

  it('uses rm --cached on an unborn branch', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('fatal: Needed a single revision'))
      .mockResolvedValueOnce({})

    await unstagePaths(['dist/assets/a.png'], run)

    expect(run.mock.calls).toEqual([
      [['rev-parse', '--verify', 'HEAD']],
      [['rm', '--cached', '--', 'dist/assets/a.png']],
    ])
  })

  it('does nothing for an empty path list', async () => {
    const run = vi.fn()

    await unstagePaths([], run)

    expect(run).not.toHaveBeenCalled()
  })
})
