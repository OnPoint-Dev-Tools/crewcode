/**
 * Markdown transcript export for a crew session — pure, no React or IPC.
 *
 * Two shapes:
 *  - shared mode → round-merged: one prompt followed by each lane's reply
 *  - isolated mode → per-lane: each lane's full thread serialised top-to-bottom
 *
 * Designed for pasting into a PR description, so it stays headed by who/what/where
 * and trims the noisy interstitial messages (worklog, in-flight tool calls).
 */

import { buildCrewRounds, type CrewLaneThread } from './crew-rounds'
import { shortModel } from './model-label'
import { formatTokens, formatElapsed } from './lane-usage-format'
import type { Message } from '../../types'
import type { CrewSession } from '../../orchestrator/crew-session'

function messageToMarkdown(msg: Message): string | null {
  switch (msg.kind) {
    case 'user':
      return `> ${msg.text}`
    case 'agent': {
      if (msg.blocks?.length) {
        return msg.blocks.map(b => b[0] === 'c' ? '```\n' + b[1] + '\n```' : b[1]).join('\n\n')
      }
      return msg.text ?? null
    }
    case 'thinking':
      return msg.text ? `_(thinking)_ ${msg.text}` : null
    case 'toolcall':
      if (msg.status === 'pending' || msg.status === 'running') return null
      return `\`tool:${msg.toolName}\`${msg.isError ? ' — **error**' : ''}`
    case 'system':
      return msg.tone === 'error' ? `> ⚠ ${msg.text}` : `> ${msg.text}`
    case 'handoff_summary':
      return `### ${msg.reason === 'compact' ? 'Compact' : 'Handoff'} summary\n\n${msg.summary}`
    case 'worklog':
    case 'activity':
    case 'compaction':
    case 'handoff':
      return null
  }
}

function laneHeader(name: string, role: string, model: string, branch: string): string {
  return `**${name}** · ${role} · \`${shortModel(model)}\` · \`${branch}\``
}

function usageLine(usage: { tokensIn: number; tokensOut: number; elapsedMs: number }): string | null {
  if (usage.tokensIn === 0 && usage.tokensOut === 0 && usage.elapsedMs === 0) return null
  return `_in ${formatTokens(usage.tokensIn)} · out ${formatTokens(usage.tokensOut)} · ${formatElapsed(usage.elapsedMs)}_`
}

export interface BuildTranscriptOpts {
  session:       CrewSession
  agentName:     (agentId: string) => string
  messagesByTab: Record<string, Message[]>
}

export function buildCrewTranscript({ session, agentName, messagesByTab }: BuildTranscriptOpts): string {
  const header = [
    `# crew · ${session.mode === 'isolated' ? 'multiple workspaces' : 'single workspace'}`,
    ``,
    `- base: \`${session.baseBranch}\``,
    `- created: ${new Date(session.createdAt).toISOString()}`,
    `- lanes: ${session.lanes.length}`,
    ``,
  ].join('\n')

  if (session.mode === 'shared') {
    const threads: CrewLaneThread[] = session.lanes.map(lane => ({
      lane,
      messages: messagesByTab[lane.tabId ?? ''] ?? [],
    }))
    const rounds = buildCrewRounds(threads)
    if (rounds.length === 0) return header + '_no activity yet._\n'

    const body = rounds.map((round, i) => {
      const lanes = round.groups.map(group => {
        const lane  = group.lane
        const lines = [
          laneHeader(agentName(lane.agentId), lane.roleName || 'no role', lane.model, lane.branch),
          ...group.messages.map(messageToMarkdown).filter((s): s is string => !!s),
        ]
        return lines.join('\n\n')
      }).join('\n\n---\n\n')
      return `## round ${i + 1}\n\n> ${round.prompt}\n\n${lanes}`
    }).join('\n\n')

    return header + body + '\n'
  }

  // isolated → per-lane sections
  const body = session.lanes.map(lane => {
    const msgs = messagesByTab[lane.tabId ?? ''] ?? []
    const lines = [
      `## ${agentName(lane.agentId)} · ${lane.roleName || 'no role'}`,
      ``,
      `- model: \`${shortModel(lane.model)}\``,
      `- branch: \`${lane.branch}\``,
      `- worktree: \`${lane.path || '—'}\``,
    ]
    const usage = usageLine(lane.usage)
    if (usage) lines.push(`- usage: ${usage}`)
    lines.push('')
    if (msgs.length === 0) {
      lines.push('_no activity in this lane._')
    } else {
      msgs.forEach(m => {
        const md = messageToMarkdown(m)
        if (md) lines.push(md, '')
      })
    }
    return lines.join('\n')
  }).join('\n---\n\n')

  return header + body + '\n'
}

export function downloadTranscript(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revoke so the browser definitely fired the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
