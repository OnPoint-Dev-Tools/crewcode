import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { parseServeOptions } from './headless'

describe('headless CLI options', () => {
  it('uses safe loopback defaults', () => {
    expect(parseServeOptions([], '/tmp')).toMatchObject({ host: '127.0.0.1', port: 3773 })
  })

  it('parses serve network and data options', () => {
    expect(parseServeOptions(['serve', '--host', '0.0.0.0', '--port', '4000', '--data-dir', 'state', '--workspace-root', 'projects'], '/tmp')).toEqual({ host: '0.0.0.0', port: 4000, dataDir: resolve('/tmp', 'state'), webRoot: undefined, allowedWorkspaceRoots: [resolve('/tmp', 'projects')] })
  })

  it('rejects invalid ports and unknown options', () => {
    expect(() => parseServeOptions(['--port', '70000'])).toThrow('invalid port')
    expect(() => parseServeOptions(['--public'])).toThrow('unknown option')
  })
})
