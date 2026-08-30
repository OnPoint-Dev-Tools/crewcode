import { describe, expect, it } from 'vitest'
import { uniqueCopyName } from './fs-copy-name'

describe('uniqueCopyName', () => {
  it('keeps the original name when it is free', () => {
    expect(uniqueCopyName('index.ts', () => false)).toBe('index.ts')
  })

  it('adds numbered copy suffixes after a collision', () => {
    const taken = new Set(['index.ts', 'index copy.ts'])
    expect(uniqueCopyName('index.ts', name => taken.has(name))).toBe('index copy 2.ts')
  })
})
