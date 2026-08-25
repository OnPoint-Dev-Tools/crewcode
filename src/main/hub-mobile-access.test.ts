import { describe, expect, it, vi } from 'vitest'
import { configureTailscaleServe, tailscaleHttpsOrigin, type RunCommand } from './hub-mobile-access'

describe('Hub mobile Tailscale access', () => {
  it('derives only a connected MagicDNS HTTPS origin', () => {
    expect(tailscaleHttpsOrigin({ BackendState: 'Running', Self: { Online: true, DNSName: 'Cortex.tailnet.ts.net.' } }))
      .toBe('https://cortex.tailnet.ts.net')
    expect(() => tailscaleHttpsOrigin({ BackendState: 'NeedsLogin', Self: { Online: false }, Health: ['logged out'] }))
      .toThrow('logged out')
    expect(() => tailscaleHttpsOrigin({ BackendState: 'Running', Self: { Online: true, DNSName: '' } }))
      .toThrow('MagicDNS')
  })

  it('configures a fixed local Hub port without replacing existing Serve routes', () => {
    const run = vi.fn<RunCommand>((_command, args) => {
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'crew.tail.ts.net.' } }), stderr: '' }
      if (args[0] === 'serve' && args[1] === 'status') return { status: 0, stdout: '{}', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    })
    expect(configureTailscaleServe(3774, { run })).toEqual({ publicOrigin: 'https://crew.tail.ts.net', changed: true })
    expect(run).toHaveBeenCalledWith('tailscale', ['serve', '--bg', '--yes', '3774'])

    const matching = vi.fn<RunCommand>((_command, args) => args[0] === 'status'
      ? { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'crew.tail.ts.net.' } }), stderr: '' }
      : { status: 0, stdout: JSON.stringify({ Web: { 'crew.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3774' } } } } }), stderr: '' })
    expect(configureTailscaleServe(3774, { run: matching })).toEqual({ publicOrigin: 'https://crew.tail.ts.net', changed: false })
    expect(matching).not.toHaveBeenCalledWith('tailscale', ['serve', '--bg', '--yes', '3774'])

    const occupied = vi.fn<RunCommand>((_command, args) => args[0] === 'status'
      ? { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'crew.tail.ts.net.' } }), stderr: '' }
      : { status: 0, stdout: JSON.stringify({ Web: { crew: {} } }), stderr: '' })
    expect(() => configureTailscaleServe(3774, { run: occupied })).toThrow('different configuration')
  })

  it('rejects ephemeral ports because the proxy target must remain stable', () => {
    expect(() => configureTailscaleServe(0, { run: vi.fn() })).toThrow('fixed Hub port')
  })
})
