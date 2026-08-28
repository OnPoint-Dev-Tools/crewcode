import type { AgentStatus, MCAgent } from './missionTypes'

export interface MissionStats {
  agents: number
  blocked: number
  running: number
  idle: number
  done: number
  worktrees: number
  tokens: number
}

/** Canonical aggregation used by every Mission Control stat presentation. */
export function deriveMissionStats(agents: ReadonlyArray<Pick<MCAgent, 'status' | 'projectId' | 'worktree' | 'tokens'>>): MissionStats {
  const count = (status: AgentStatus): number => agents.filter(agent => agent.status === status).length
  return {
    agents: agents.length,
    blocked: count('blocked'),
    running: count('running'),
    idle: count('idle'),
    done: count('done'),
    worktrees: new Set(agents.map(agent => `${agent.projectId}/${agent.worktree}`)).size,
    tokens: agents.reduce((total, agent) => total + agent.tokens, 0),
  }
}
