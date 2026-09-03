import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { isBrainAuthorizationDenial } from './brain-authorization-runtime'
import { WebRpcError } from './web-rpc-client'

describe('Brain authorization denials', () => {
  it('treats an empty Brain policy as a grant problem, not a dead tunnel', () => {
    expect(isBrainAuthorizationDenial(new WebRpcError(
      'Brain authorization does not grant workspace:read for workspaces.list',
      'FORBIDDEN',
    ))).toBe(true)
    expect(isBrainAuthorizationDenial(new WebRpcError(
      'Brain authorization does not expose unknown.execute',
      'FORBIDDEN',
    ))).toBe(true)
  })

  it('does not swallow pairing, transport, or other forbidden failures', () => {
    expect(isBrainAuthorizationDenial(new WebRpcError('pairing failed', 'UNAUTHENTICATED', 401))).toBe(false)
    expect(isBrainAuthorizationDenial(new WebRpcError('path escapes root', 'FORBIDDEN'))).toBe(false)
    expect(isBrainAuthorizationDenial(new Error('Brain authorization does not grant workspace:read for workspaces.list'))).toBe(false)
  })

  it('lets a Hub web session mount when Brain policy is still empty', () => {
    const connection = readFileSync(join(__dirname, 'WebConnectionScreen.tsx'), 'utf8')
    expect(connection).toContain('isBrainAuthorizationDenial(error)')
    expect(connection).toContain('await client.workspacesList()')
  })
})
