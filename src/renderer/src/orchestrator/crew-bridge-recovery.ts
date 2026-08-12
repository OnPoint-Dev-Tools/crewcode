export interface CrewBridgePromptResult {
  ok: boolean
  error?: string
}

interface CrewBridgeStart {
  bridgeId: string
  prompt: string
}

/**
 * Submit a Crew lane prompt, replacing a stale/stopping bridge once when main
 * reports that its runtime no longer exists. The restart callback owns registry
 * replacement and worker re-priming for the new runtime id.
 */
export async function promptCrewBridgeWithRecovery(
  initial: CrewBridgeStart,
  prompt: (bridgeId: string, text: string) => Promise<CrewBridgePromptResult>,
  restart: () => Promise<CrewBridgeStart | { error: string }>,
): Promise<CrewBridgePromptResult> {
  const first = await prompt(initial.bridgeId, initial.prompt)
  if (first.ok || first.error !== 'bridge not found') return first

  const replacement = await restart()
  if ('error' in replacement) return { ok: false, error: replacement.error }
  return prompt(replacement.bridgeId, replacement.prompt)
}
