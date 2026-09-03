import type { ManagedHubRelayTransport } from './hub-relay-client'
import { WebRpcError } from './web-rpc-client'

let relay: ManagedHubRelayTransport | null = null
export function installBrainAuthorizationRelay(next: ManagedHubRelayTransport): void { relay = next }
export function brainAuthorizationRelay(): ManagedHubRelayTransport | null { return relay }

/** Empty Brain policy is fail-closed, not a broken tunnel. The owner must still
 *  reach Settings → Brain Access to grant roots and scopes. */
export function isBrainAuthorizationDenial(error: unknown): boolean {
  return error instanceof WebRpcError
    && error.code === 'FORBIDDEN'
    && error.message.startsWith('Brain authorization does not ')
}
