import { homedir, hostname } from 'os'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { mobileQrTarget, normalizeHubOrigin, parseHubOptions, terminalLink } from './hub'
import { defaultBrainDataDir } from './hub-machine-enrollment'

const hubDefaults = {
  localBrain: false,
  brainDataDir: defaultBrainDataDir(),
  brainName: hostname(),
  allowedWorkspaceRoots: [] as string[],
  allowedScopes: [] as string[],
}

describe('Hub CLI options', () => {
  it('prints a clickable terminal link with a plain-text fallback', () => {
    expect(terminalLink('Open setup', 'http://localhost:3774/#bootstrap=secret', true)).toBe('\u001B]8;;http://localhost:3774/#bootstrap=secret\u0007Open setup\u001B]8;;\u0007')
    expect(terminalLink('Open setup', 'http://localhost:3774/#bootstrap=secret', false)).toBe('http://localhost:3774/#bootstrap=secret')
  })
  it('uses the one-time bootstrap URL only for initial-owner QR setup', () => {
    const origin = 'https://cortex.tail.ts.net'
    const bootstrap = `${origin}/#bootstrap=one-time-secret`
    expect(mobileQrTarget(origin, bootstrap)).toEqual({ url: bootstrap, containsCredential: true })
    expect(mobileQrTarget(origin)).toEqual({ url: origin, containsCredential: false })
  })

  it('uses safe loopback defaults', () => {
    expect(parseHubOptions([], '/tmp')).toMatchObject({ host: '127.0.0.1', port: 3774, ...hubDefaults })
  })

  it('parses an explicit network deployment', () => {
    expect(parseHubOptions(['hub', '--host', '0.0.0.0', '--port', '4444', '--data-dir', 'state', '--public-origin', 'https://crewcode.example'], '/tmp')).toEqual({
      host: '0.0.0.0',
      port: 4444,
      dataDir: resolve('/tmp', 'state'),
      publicOrigin: 'https://crewcode.example',
      mobile: false,
      tailscale: false,
      tailscaleReplace: false,
      ...hubDefaults,
      brainDataDir: defaultBrainDataDir(),
    })
  })

  it('parses a local Brain supervisor on the Hub host', () => {
    expect(parseHubOptions([
      '--local-brain',
      '--brain-data-dir', 'brain-state',
      '--brain-name', 'vps',
      '--workspace-root', 'projects',
      '--allow-scope', 'agent',
      '--allow-scope', 'workspace:read',
    ], '/tmp')).toEqual({
      host: '127.0.0.1',
      port: 3774,
      dataDir: resolve(homedir(), '.crewcode/hub'),
      publicOrigin: undefined,
      mobile: false,
      tailscale: false,
      tailscaleReplace: false,
      localBrain: true,
      brainDataDir: resolve('/tmp', 'brain-state'),
      brainName: 'vps',
      allowedWorkspaceRoots: [resolve('/tmp', 'projects')],
      allowedScopes: ['agent', 'workspace:read'],
    })
  })

  it('refuses Brain flags without --local-brain and scopes without a workspace root', () => {
    expect(() => parseHubOptions(['--workspace-root', '/tmp/projects'])).toThrow('--local-brain')
    expect(() => parseHubOptions(['--local-brain', '--allow-scope', 'agent'])).toThrow('--workspace-root')
  })

  it('supports Tailscale and generic HTTPS mobile modes', () => {
    expect(parseHubOptions(['mobile'], '/tmp')).toMatchObject({ mobile: true, tailscale: true, port: 3774 })
    expect(parseHubOptions(['mobile', '--public-origin', 'https://crewcode.example'], '/tmp')).toMatchObject({ mobile: true, tailscale: false, publicOrigin: 'https://crewcode.example' })
    expect(() => parseHubOptions(['mobile', '--tailscale', '--public-origin', 'https://crewcode.example'], '/tmp')).toThrow('either --tailscale or --public-origin')
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
