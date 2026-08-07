import { describe, expect, it } from 'vitest'

import { parseMcpConfig } from './mcp-config-parse'

describe('parseMcpConfig', () => {
  it('parses the standard mcpServers map form, deriving id+name from the key', () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', 'srv-fs', '/tmp'], env: { ROOT: '/tmp' } },
      },
    })
    expect(errors).toEqual([])
    expect(servers).toEqual([
      { id: 'filesystem', name: 'filesystem', command: 'npx', args: ['-y', 'srv-fs', '/tmp'], env: { ROOT: '/tmp' }, transport: 'stdio' },
    ])
  })

  it('parses the explicit servers array form', () => {
    const { servers, errors } = parseMcpConfig({
      servers: [{ id: 'git', name: 'Git', command: 'mcp-git' }],
    })
    expect(errors).toEqual([])
    expect(servers).toEqual([
      { id: 'git', name: 'Git', command: 'mcp-git', args: [], env: {}, transport: 'stdio' },
    ])
  })

  it('parses a bare top-level array', () => {
    const { servers } = parseMcpConfig([{ id: 'a', command: 'a-cmd' }])
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ id: 'a', name: 'a', command: 'a-cmd' })
  })

  it('skips bad entries with an error but keeps the good ones', () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: {
        good: { command: 'ok' },
        bad: { args: ['no command'] },
      },
    })
    expect(servers.map(s => s.id)).toEqual(['good'])
    expect(errors.join(' ')).toContain('mcpServers.bad')
  })

  it('rejects an unrecognized root shape', () => {
    expect(parseMcpConfig({ nope: 1 }).errors).toHaveLength(1)
    expect(parseMcpConfig(42).errors).toHaveLength(1)
  })

  it('drops duplicate ids, keeping the first', () => {
    const { servers, errors } = parseMcpConfig({
      servers: [
        { id: 'dup', command: 'first' },
        { id: 'dup', command: 'second' },
      ],
    })
    expect(servers).toHaveLength(1)
    expect(servers[0].command).toBe('first')
    expect(errors.join(' ')).toContain('duplicate')
  })

  it('validates env and args types', () => {
    expect(parseMcpConfig({ servers: [{ id: 'x', command: 'c', args: 'nope' }] }).errors.join(' ')).toContain('args')
    expect(parseMcpConfig({ servers: [{ id: 'x', command: 'c', env: { K: 1 } }] }).errors.join(' ')).toContain('env')
  })
})
