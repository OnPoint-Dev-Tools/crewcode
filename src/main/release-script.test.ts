import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('release script terminal custody', () => {
  it('keeps npm verification/version work out of interactive shell job control', () => {
    const source = readFileSync(join(__dirname, '../../scripts/release.mjs'), 'utf8')

    expect(source).toContain("stdio: ['ignore', 'inherit', 'inherit']")
    expect(source).toContain("env: { ...process.env, CI: '1' }")
    expect(source).toContain("const git = args => execFileSync('git', args, { stdio: 'inherit' })")
  })
})
