import { describe, expect, it } from 'vitest'
import { BUILD_HASH, createAppBuildInfo } from './build-info'

describe('app build info', () => {
  it('combines the runtime version with the build-time commit identity', () => {
    expect(createAppBuildInfo('9.8.7', true)).toEqual({
      version: '9.8.7',
      buildHash: BUILD_HASH,
      packaged: true,
    })
  })
})
