// `opencode-go` is the hosted OpenAI-compatible Go API, deliberately distinct
// from `opencode`, which is CrewCode's local/server agent bridge.
export type CompletionProviderId = 'opencode-go' | 'pi' | 'opencode' | 'codex' | 'claude' | 'hermes' | 'ollama' | 'openrouter'

export interface AgentCompletionRequest {
  requestId: string
  provider: CompletionProviderId
  model?: string
  cwd: string
  rel: string
  language: string
  prefix: string
  suffix: string
}

export interface AgentCompletionResult {
  ok: boolean
  completion?: string
  error?: string
}
