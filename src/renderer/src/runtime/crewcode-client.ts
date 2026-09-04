import type { CrewCodeRuntimeKind } from '../../../shared/remote-access-types'

export type CrewCodeClient = NonNullable<Window['electronAPI']>

export interface CrewCodeRuntime {
  kind: CrewCodeRuntimeKind
  client: CrewCodeClient
  /** Present only when the renderer was opened through an authenticated Hub. */
  hubControl?: true
}

let runtime: CrewCodeRuntime | null = null

export function installCrewCodeRuntime(next: CrewCodeRuntime): void {
  if (runtime) throw new Error('CrewCode runtime is already installed')
  runtime = next

  // Transitional compatibility for renderer surfaces that have not yet moved
  // to getCrewCodeClient(). This is the allowlisted browser adapter, never the
  // Electron preload bridge or raw server RPC transport.
  if (next.kind !== 'electron') window.electronAPI = next.client
}

export function getCrewCodeRuntime(): CrewCodeRuntime {
  if (!runtime) throw new Error('CrewCode runtime has not been installed')
  return runtime
}

export function getCrewCodeClient(): CrewCodeClient {
  return getCrewCodeRuntime().client
}

export function initializeCrewCodeRuntime(): CrewCodeRuntime {
  if (runtime) return runtime
  if (window.electronAPI) {
    runtime = { kind: 'electron', client: window.electronAPI }
    return runtime
  }

  // Do not silently build a partial browser shim. A web client must negotiate
  // the versioned server contract before the privileged application mounts.
  throw new Error('No CrewCode backend is available. Connect this browser to a CrewCode server.')
}
