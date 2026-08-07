/**
 * Agent CLIs that should appear only as raw terminal panes, never as chat/crew
 * orchestration providers. Keep this explicit so future terminal-only runtimes
 * can be excluded without encoding transport quirks in every picker.
 */

export const TERMINAL_ONLY_AGENT_IDS: ReadonlySet<string> = new Set()

/** Agents eligible to drive a chat thread, a crew lane, or the supervisor. */
export function orchestrationAgents<T extends { id: string }>(agents: readonly T[]): T[] {
  return agents.filter(a => !TERMINAL_ONLY_AGENT_IDS.has(a.id))
}
