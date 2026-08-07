export type LanguageServerStatus = 'starting' | 'ready' | 'error' | 'stopped'

export interface LanguageServerStartResult {
  ok: boolean
  handleId?: string
  rootUri?: string
  error?: string
}

export interface LanguageServerMessageEvent {
  handleId: string
  message: string
}

export interface LanguageServerStatusEvent {
  handleId: string
  status: LanguageServerStatus
  error?: string
}
