// Mission Control data shapes — intentionally close to what a real
// CrewCode store would expose so swapping mock data for live selectors is a
// shallow rename.

import type { AgentUserRequest } from '../../types'

export interface MCProject {
  id:   string
  name: string
  path: string
}

export type AgentKind   = 'codex' | 'claude'
export type AgentStatus = 'blocked' | 'running' | 'idle' | 'done'
export type AgentMode   = 'Ask' | 'Plan' | 'Build' | 'Full'

export interface BlockingQuestion {
  kind:         'question' | 'approval'
  text:         string
  choices:      string[]
  destructive?: boolean
}

export interface AgentProgress {
  current: string
  step:    number
  of:      number
  done?:   boolean
}

export interface MCAgent {
  id:           string
  name:         string
  agent:        AgentKind
  model:        string
  mode:         AgentMode
  projectId:    string
  branch:       string
  worktree:     string
  status:       AgentStatus
  lastActivity: string
  /** Epoch ms of last activity — sortable companion to the `lastActivity` label. */
  lastActivityMs: number
  tokens:       number
  cost:         number
  blocking?:    BlockingQuestion
  /**
   * Live, interactive provider pause (permission / question / select) routed
   * from the bridge — actionable from any surface, unlike the transcript-derived
   * `blocking` hint which is display-only.
   */
  request?:     AgentUserRequest
  lastLine:     string
  progress:     AgentProgress | null
}

export type FeedKind = 'block' | 'worktree' | 'unread' | 'done' | 'cmd' | 'cost'

export interface FeedEvent {
  id:        string
  kind:      FeedKind
  time:      string
  projectId: string
  agentId:   string | null
  text:      string
}

export type Grouping = 'project' | 'status' | 'type' | 'worktree'
export type Filter   = 'all' | 'blocked' | 'running' | 'idle' | 'done'

export interface Group {
  id:     string
  name:   string
  meta?:  string
  icon:   string
  agents: MCAgent[]
}
