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

  // CrewCoder now exposes provider:model ids, but sessions persisted before
  // that contract (and a configured default supplied by the parent process)
  // can still contain an unprefixed Codex model. Treat the known GPT model
  // family as Codex only for CrewCoder; other wrapper agents may route the
  // same model name through OpenRouter or another account.
  if (agentId.toLowerCase() === 'crewcoder' && /^gpt-/i.test(value)) {
    return 'codex'
  }

  return RATE_LIMIT_PROVIDER_ALIASES[agentId.toLowerCase()] ?? agentId
}
