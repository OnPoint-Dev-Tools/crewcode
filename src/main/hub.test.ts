import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { normalizeHubOrigin, parseHubOptions, terminalLink } from './hub'

describe('Hub CLI options', () => {
  it('prints a clickable terminal link with a plain-text fallback', () => {
    expect(terminalLink('Open setup', 'http://localhost:3774/#bootstrap=secret', true)).toBe('\u001B]8;;http://localhost:3774/#bootstrap=secret\u0007Open setup\u001B]8;;\u0007')
    expect(terminalLink('Open setup', 'http://localhost:3774/#bootstrap=secret', false)).toBe('http://localhost:3774/#bootstrap=secret')
  })
  it('uses safe loopback defaults', () => {
    expect(parseHubOptions([], '/tmp')).toMatchObject({ host: '127.0.0.1', port: 3774 })
  })

  it('parses an explicit network deployment', () => {
    expect(parseHubOptions(['hub', '--host', '0.0.0.0', '--port', '4444', '--data-dir', 'state', '--public-origin', 'https://crewcode.example'], '/tmp')).toEqual({
      host: '0.0.0.0',
      port: 4444,
      dataDir: resolve('/tmp', 'state'),
      publicOrigin: 'https://crewcode.example',
    })
  })

  it('requires a final public origin for wildcard binds', () => {
    expect(() => parseHubOptions(['--host', '0.0.0.0'])).toThrow('--public-origin is required')
  })

  it('only accepts secure or loopback browser origins', () => {
    expect(normalizeHubOrigin('https://crewcode.example/')).toBe('https://crewcode.example')
    expect(normalizeHubOrigin('http://localhost:3774')).toBe('http://localhost:3774')
    expect(() => normalizeHubOrigin('http://crewcode.example')).toThrow('use HTTPS')
    expect(() => normalizeHubOrigin('https://crewcode.example/path')).toThrow('no path')
  })
})
