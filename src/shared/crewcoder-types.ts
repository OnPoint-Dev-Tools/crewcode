/** CrewCoder's agent-profile modes. These are distinct from CrewCode's execution modes. */
export const CREWCODER_MODES = ['general', 'crewcoder', 'plugin', 'extension'] as const

export type CrewCoderMode = typeof CREWCODER_MODES[number]

/** CrewCoder approval policies intentionally exposed by CrewCode. */
export const CREWCODER_APPROVAL_MODES = ['review', 'always', 'never', 'full-access', 'sandboxed'] as const

export type CrewCoderApprovalMode = typeof CREWCODER_APPROVAL_MODES[number]

export function isCrewCoderMode(value: unknown): value is CrewCoderMode {
  return typeof value === 'string' && (CREWCODER_MODES as readonly string[]).includes(value)
}

export function normalizeCrewCoderMode(value: unknown): CrewCoderMode {
  return isCrewCoderMode(value) ? value : 'general'
}

export function isCrewCoderApprovalMode(value: unknown): value is CrewCoderApprovalMode {
  return typeof value === 'string' && (CREWCODER_APPROVAL_MODES as readonly string[]).includes(value)
}

export function normalizeCrewCoderApprovalMode(value: unknown): CrewCoderApprovalMode {
  return isCrewCoderApprovalMode(value) ? value : 'review'
}

/** Full access must never remain effective when its visible CrewCoder profile is off. */
export function crewCoderApprovalForProfile(mode: CrewCoderMode | undefined, value: unknown): CrewCoderApprovalMode {
  return mode === 'crewcoder' ? normalizeCrewCoderApprovalMode(value) : 'review'
}

/** A concrete CrewCoder profile owns behavior while CrewCode retains Build's approval gate. */
export function crewCoderProfileLocksExecutionMode(provider: string, mode: CrewCoderMode | undefined): boolean {
  return provider === 'crewcoder' && mode !== undefined
}
