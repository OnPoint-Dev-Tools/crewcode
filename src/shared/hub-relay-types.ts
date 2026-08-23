import type { CrewCodeRemoteRequest, CrewCodeRemoteResponse } from './remote-access-types'

export const CREWCODE_HUB_RELAY_PROTOCOL = 'crewcode.hub-relay.v1' as const
export const HUB_CONNECTION_TICKET_TTL_MS = 60_000
export const HUB_RELAY_MAX_FRAME_BYTES = 1024 * 1024
export const HUB_RELAY_IDLE_TIMEOUT_MS = 30 * 60_000
export const HUB_RELAY_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60_000

export type BrainAccessScope = 'workspace:read' | 'workspace:write' | 'terminal' | 'agent'

export interface HubConnectionTicketResponse {
  ticket: string
  expiresAt: number
  machineId: string
  machinePublicKey: string
  requestedScopes: BrainAccessScope[]
}

export type HubRelayControlFrame =
  | { type: 'brainReady'; machineId: string }
  | { type: 'connect'; connectionId: string; userId: string; browserSessionId: string; requestedScopes: BrainAccessScope[] }
  | { type: 'ready'; connectionId: string; machineId: string; machinePublicKey: string; requestedScopes: BrainAccessScope[] }
  | { type: 'clientHello'; connectionId: string; key: string }
  | { type: 'serverHello'; connectionId: string; key: string; signature: string; grantedScopes: BrainAccessScope[] }
  | { type: 'encrypted'; connectionId: string; sequence: number; ciphertext: string }
  | { type: 'close'; connectionId: string; reason: string }

export type HubTunnelPlaintext =
  | { type: 'rpc'; request: CrewCodeRemoteRequest }
  | { type: 'rpcResult'; response: CrewCodeRemoteResponse }
  | { type: 'event'; channel: 'pty' | 'bridge'; event: unknown }
  | { type: 'error'; code: string; message: string }
