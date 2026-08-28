import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { parseServeOptions } from './headless'

describe('headless CLI options', () => {
  it('uses safe loopback defaults', () => {
    expect(parseServeOptions([], '/tmp')).toMatchObject({ host: '127.0.0.1', port: 3773 })
  })

  it('parses serve network and data options', () => {
    expect(parseServeOptions(['serve', '--host', '0.0.0.0', '--port', '4000', '--data-dir', 'state', '--workspace-root', 'projects', '--public-origin', 'https://crewcode.example'], '/tmp')).toEqual({ host: '0.0.0.0', port: 4000, dataDir: resolve('/tmp', 'state'), webRoot: undefined, allowedWorkspaceRoots: [resolve('/tmp', 'projects')], publicOrigins: ['https://crewcode.example'] })
  })

  it('rejects invalid ports, public origins, and unknown options', () => {
    expect(() => parseServeOptions(['--port', '70000'])).toThrow('invalid port')
    expect(() => parseServeOptions(['--public-origin', 'https://crewcode.example/path'])).toThrow('invalid public origin')
    expect(() => parseServeOptions(['--public-origin', 'file:///tmp/hub'])).toThrow('invalid public origin')
    expect(() => parseServeOptions(['--public'])).toThrow('unknown option')
  })
})
