/**
 * Decision guide — maps a recognisable task shape to a recommended crew mode.
 * Drives the "which workspace setup?" picker in the chat config selector.
 */

import type { CrewMode } from './crew-session'

export interface TaskShape {
  id:        string
  /** What the developer is about to do, in their words. */
  scenario:  string
  recommend: CrewMode
  /** Human label for the recommended mode. */
  modeLabel: string
  /** Why this mode fits — shown under the recommendation. */
  rationale: string
}

/**
 * The five canonical task shapes. Ordered so the two modes alternate, which
 * keeps the picker from reading as "always pick multiple".
 */
export const TASK_SHAPES: readonly TaskShape[] = [
  {
    id:        'features-separate',
    scenario:  'Two features that ship separately',
    recommend: 'isolated',
    modeLabel: 'Multiple Workspaces',
    rationale: 'Isolated branches — each feature lands on its own PR independently.',
  },
  {
    id:        'implement-and-test',
    scenario:  'One feature: implementation + test repair',
    recommend: 'shared',
    modeLabel: 'Single Workspace',
    rationale: 'Shared branch — implementer and tester work the same diff together.',
  },
  {
    id:        'issues-parallel',
    scenario:  'Several issues explored in parallel',
    recommend: 'isolated',
    modeLabel: 'Multiple Workspaces',
    rationale: 'Independent worktrees — merge the wins, discard the dead ends.',
  },
  {
    id:        'second-opinion',
    scenario:  'One branch needs a second opinion',
    recommend: 'shared',
    modeLabel: 'Single Workspace',
    rationale: 'Same diff review — a reviewer agent reads exactly what was written.',
  },
  {
    id:        'risky-experiment',
    scenario:  'A risky experiment',
    recommend: 'isolated',
    modeLabel: 'Multiple Workspaces',
    rationale: 'Isolated from main work — throw the whole worktree away if it fails.',
  },
] as const

/** Look up the recommended mode for a task shape id, or null if unknown. */
export function recommendMode(shapeId: string): CrewMode | null {
  return TASK_SHAPES.find(s => s.id === shapeId)?.recommend ?? null
}
