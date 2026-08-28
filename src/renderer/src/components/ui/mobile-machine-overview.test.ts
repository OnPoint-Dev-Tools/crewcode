import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const overview = readFileSync(join(__dirname, 'MobileMachineOverview.tsx'), 'utf8')
const connection = readFileSync(join(__dirname, '../../runtime/WebConnectionScreen.tsx'), 'utf8')
const transcriptService = readFileSync(join(__dirname, '../../../../main/transcript-service.ts'), 'utf8')
const app = readFileSync(join(__dirname, '../../App.tsx'), 'utf8')

describe('Hub mobile selected-machine overview', () => {
  it('routes a selected mobile desktop through an overview before full CrewCode', () => {
    expect(connection).toContain("`/app?hub=mobile&machine=${encodeURIComponent(machineId)}`")
    expect(connection).toContain('<HubMobileMachineOverview machineId={machineId} />')
    expect(connection).toContain("const query = new URLSearchParams({ machine: machineId })")
    expect(connection).toContain("window.location.assign(`/app?${query.toString()}`)")
  })

  it('carries and consumes an exact validated thread address', () => {
    expect(connection).toContain("query.set('thread', thread.scopeId)")
    expect(connection).toContain("query.set('threadTab', thread.tabId)")
    expect(connection).toContain("query.set('threadWorkspace', thread.workspaceId)")
    expect(app).toContain("query.get('thread')")
    expect(app).toContain('chatSessions.restoreRemote')
    expect(app).toContain('restoreChatTabInWorkspace(workspace.id, workspace.name, tabId)')
    expect(app).toContain('chatSessions.activate(tabId, scopeId)')
    expect(app).toContain('const ownsScope = scopeId === tabId')
  })

  it('reads real Brain data over the encrypted relay and keeps unavailable stats explicit', () => {
    expect(connection).toContain("connectHubRelayTransport(machineId, ['workspace:read', 'agent'])")
    expect(connection).toContain("rpc<MobileOverviewWorkspace[]>('workspaces.list'")
    expect(connection).toContain("rpc<{ executions: BrainExecutionSummary[] }>('bridge.list'")
    expect(connection).toContain("rpc<RecentTranscriptSummary[]>('transcripts.recent'")
    expect(connection).toContain("worktrees: null, agents: null, running: null, done: null")
    expect(overview).toContain("{value ?? '—'}")
    expect(connection).toContain('deriveMissionStats(missionAgents)')
  })

  it('returns bounded recent-thread metadata instead of full transcript bodies', () => {
    expect(transcriptService).toContain('recent(limit = 5): RecentTranscriptSummary[]')
    expect(transcriptService).toContain('firstUserText')
    expect(transcriptService).toContain('.slice(0, 240)')
    expect(connection).not.toContain("rpc<Record<string, Message[]>>('transcripts.loadAll'")
  })

  it('falls back to transcript timestamps when an older Brain lacks the summary method', () => {
    expect(connection).toContain("cause.code !== 'UNSUPPORTED'")
    expect(connection).toContain("rpc<Record<string, number>>('transcripts.mtimes'")
    expect(connection).toContain('.slice(0, 5)')
    expect(connection).toContain('firstUserText: null')
  })

  it('uses CrewCode icons and has explicit back, refresh, and full-app actions', () => {
    expect(overview).toContain('<MobileBrand isDark={isDark} />')
    expect(overview).toContain('Back to desktops')
    expect(overview).toContain('Recent threads')
    expect(overview).toContain('Open CrewCode')
    expect(overview).not.toMatch(/[🤖🕐✓]/u)
  })
})
