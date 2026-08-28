/** CrewCoder's agent-profile modes. These are distinct from CrewCode's execution modes. */
export const CREWCODER_MODES = ['general', 'crewcoder', 'plugin', 'extension'] as const

export type CrewCoderMode = typeof CREWCODER_MODES[number]

export function isCrewCoderMode(value: unknown): value is CrewCoderMode {
  return typeof value === 'string' && (CREWCODER_MODES as readonly string[]).includes(value)
}

export function normalizeCrewCoderMode(value: unknown): CrewCoderMode {
  return isCrewCoderMode(value) ? value : 'general'
}

/** A concrete CrewCoder profile owns behavior while CrewCode retains Build's approval gate. */
export function crewCoderProfileLocksExecutionMode(provider: string, mode: CrewCoderMode | undefined): boolean {
  return provider === 'crewcoder' && mode !== undefined
}
