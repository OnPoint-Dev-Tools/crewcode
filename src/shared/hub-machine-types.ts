export type HubMachineStatus = 'offline' | 'online' | 'disabled' | 'revoked'

export interface HubMachineSummary {
  id: string
  name: string
  status: HubMachineStatus
  platform: string | null
  version: string | null
  createdAt: number
  lastSeenAt: number | null
  disabledAt: number | null
  revokedAt: number | null
}

export interface HubMachineListResult {
  machines: HubMachineSummary[]
}

export interface HubMachineStateResult {
  ok: true
  machine: HubMachineSummary
}
