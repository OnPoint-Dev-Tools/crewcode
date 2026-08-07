import type { AgentUserRequest, AgentUserResponse, BridgeStartOpts } from './bridge-types'

type PermissionRequest = Omit<AgentUserRequest, 'requestId' | 'bridgeId'>

function grantKey(bridgeId: string, turnId: string): string {
  return `${bridgeId}\0${turnId}`
}

/**
 * Tracks an explicit Build-mode approval only until the owning provider turn
 * ends. Provider-native remembered choices are deliberately not used because
 * they can outlive CrewCode's session/mode policy.
 */
export class TurnPermissionGrantStore {
  private readonly grants = new Set<string>()

  prepareRequest(
    bridgeId: string,
    mode: BridgeStartOpts['mode'],
    toolPolicy: BridgeStartOpts['toolPolicy'],
    request: PermissionRequest,
  ): { request: PermissionRequest; autoResponse?: AgentUserResponse } {
    // This capability belongs to CrewCode, never the provider. Strip any
    // provider-supplied value before deciding whether to issue it ourselves.
    const { allowAllForTurn: _ignored, ...sanitizedRequest } = request
    const eligible = sanitizedRequest.kind === 'permission'
      && typeof sanitizedRequest.turnId === 'string'
      && sanitizedRequest.turnId.length > 0
      && mode === 'build'
      && toolPolicy !== 'read-only'

    if (!eligible) return { request: sanitizedRequest }
    if (this.grants.has(grantKey(bridgeId, sanitizedRequest.turnId!))) {
      return {
        request: sanitizedRequest,
        autoResponse: {
          requestId: `${bridgeId}-turn-auto-allow`,
          action: 'accept',
        },
      }
    }
    return { request: { ...sanitizedRequest, allowAllForTurn: true } }
  }

  grant(bridgeId: string, request: AgentUserRequest): boolean {
    if (!request.allowAllForTurn || request.kind !== 'permission' || !request.turnId) return false
    this.grants.add(grantKey(bridgeId, request.turnId))
    return true
  }

  clearTurn(bridgeId: string, turnId: string): void {
    this.grants.delete(grantKey(bridgeId, turnId))
  }

  clearBridge(bridgeId: string): void {
    const prefix = `${bridgeId}\0`
    for (const key of this.grants) if (key.startsWith(prefix)) this.grants.delete(key)
  }

  clear(): void {
    this.grants.clear()
  }
}
