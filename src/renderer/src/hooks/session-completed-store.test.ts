import { describe, expect, it } from 'vitest'

import {
  boundCompletedMap,
  forgetScopes,
  parseCompletedMap,
} from './session-completed-store'

describe('parseCompletedMap', () => {
  it('returns empty for null/empty/garbage', () => {
    expect(parseCompletedMap(null)).toEqual({})
    expect(parseCompletedMap('')).toEqual({})
    expect(parseCompletedMap('not json')).toEqual({})
    expect(parseCompletedMap('[1,2,3]')).toEqual({})
    expect(parseCompletedMap('"a"')).toEqual({})
  })

  it('keeps only finite-number entries', () => {
    const raw = JSON.stringify({ a: 1000, b: 'nope', c: null, d: 2000, e: Number.NaN })
    expect(parseCompletedMap(raw)).toEqual({ a: 1000, d: 2000 })
  })
})

describe('boundCompletedMap', () => {
  it('returns the same reference when within budget', () => {
    const map = { a: 1, b: 2 }
    expect(boundCompletedMap(map, 5)).toBe(map)
  })

  it('keeps only the newest entries by timestamp when over budget', () => {
    const map = { old: 10, mid: 20, new: 30, newest: 40 }
    const bounded = boundCompletedMap(map, 2)
    expect(bounded).toEqual({ newest: 40, new: 30 })
    expect(Object.keys(bounded)).toHaveLength(2)
  })
})

describe('forgetScopes', () => {
  it('removes listed scopes', () => {
    expect(forgetScopes({ a: 1, b: 2, c: 3 }, ['b'])).toEqual({ a: 1, c: 3 })
  })

  it('returns the original reference when nothing matched', () => {
    const map = { a: 1 }
    expect(forgetScopes(map, ['x', 'y'])).toBe(map)
  })
})
