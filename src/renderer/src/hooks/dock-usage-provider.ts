const RATE_LIMIT_PROVIDER_ALIASES: Record<string, string> = {
  anthropic: 'claude',
  claude: 'claude',
  codex: 'codex',
  'openai-codex': 'codex',
  opencode: 'opencode',
  'opencode-go': 'opencode',
  openrouter: 'openrouter',
}

/**
 * Resolve the provider whose account limits back the selected agent/model.
 * Wrapper agents (for example CrewCoder or Pi) encode their upstream provider
 * in a `provider:model` or `provider/model` model id.
 */
export function dockUsageProviderId(agentId: string, model: string): string {
  const value = model.trim()
  const separator = value.search(/[:/]/)
  if (separator > 0) {
    const modelProvider = value.slice(0, separator).trim().toLowerCase()
    const resolved = RATE_LIMIT_PROVIDER_ALIASES[modelProvider]
    if (resolved) return resolved
  }

  return RATE_LIMIT_PROVIDER_ALIASES[agentId.toLowerCase()] ?? agentId
}
