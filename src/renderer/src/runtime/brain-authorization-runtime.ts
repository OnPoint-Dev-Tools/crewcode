import type { ManagedHubRelayTransport } from './hub-relay-client'

let relay: ManagedHubRelayTransport | null = null
export function installBrainAuthorizationRelay(next: ManagedHubRelayTransport): void { relay = next }
export function brainAuthorizationRelay(): ManagedHubRelayTransport | null { return relay }
