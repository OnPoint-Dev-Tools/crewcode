export const CREWCODE_REMOTE_PROTOCOL_VERSION = 1 as const

export type CrewCodeRuntimeKind = 'electron' | 'web'

export interface CrewCodeServerCapabilities {
  protocolVersion: typeof CREWCODE_REMOTE_PROTOCOL_VERSION
  runtime: 'server'
  platform: NodeJS.Platform
  features: {
    workspaces: boolean
    filesystem: boolean
    git: boolean
    terminals: boolean
    agents: boolean
  }
}

export interface CrewCodeRemoteError {
  code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_REQUEST' | 'UNSUPPORTED' | 'INTERNAL'
  message: string
}

/** Versioned envelope used by the future HTTP and WebSocket transports. */
export interface CrewCodeRemoteRequest<T = unknown> {
  protocolVersion: typeof CREWCODE_REMOTE_PROTOCOL_VERSION
  id: string
  method: string
  params: T
}

export type CrewCodeRemoteResponse<T = unknown> =
  | { protocolVersion: typeof CREWCODE_REMOTE_PROTOCOL_VERSION; id: string; ok: true; result: T }
  | { protocolVersion: typeof CREWCODE_REMOTE_PROTOCOL_VERSION; id: string; ok: false; error: CrewCodeRemoteError }
