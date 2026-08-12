import type { CrewAgentLane } from './crew-session'

/**
 * Git review data only changes when lane ownership changes. Runtime status,
 * token counters, pause notes, and bridge ids must not clear already-loaded
 * Compare/Merge evidence or make those surfaces flash back to "loading".
 */
export function crewReviewFingerprint(lanes: CrewAgentLane[]): string {
  return JSON.stringify(lanes.map(lane => [
    lane.laneId,
    lane.path,
    lane.branch,
    lane.status === 'pending' ? 'pending' : 'owned',
  ]))
}
