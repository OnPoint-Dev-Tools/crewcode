import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { useSystemStats, type SystemStatsState } from '../../hooks/useSystemStats'
import type { ProcessSample } from '../../types'

// A live terminal (PTY) session, sourced from the renderer's pane state so the
// kill path stays in sync with the terminal grid layout. `wsId` lets the monitor
// group it under its workspace.
export interface TerminalDaemon {
  id:      string
  wsId:    string
  tabId:   string
  title:   string
  sub:     string
  agentId: string | null
}

export interface MonitorWorkspace {
  id:   string
  name: string
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const val = bytes / 1024 ** i
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

interface SparklineProps {
  data: number[]
  max:  number
  tone?: 'cpu' | 'mem'
}

function Sparkline({ data, max, tone = 'cpu' }: SparklineProps) {
  const W = 88
  const H = 22
  if (data.length < 2) {
    return <svg className={`sysmon-spark ${tone}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} />
  }
  const ceil = max > 0 ? max : 1
  const step = W / (data.length - 1)
  const pts = data.map((v, i) => {
    const x = i * step
    const y = H - (Math.max(0, Math.min(ceil, v)) / ceil) * (H - 2) - 1
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const area = `0,${H} ${pts.join(' ')} ${W},${H}`
  return (
    <svg className={`sysmon-spark ${tone}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon className="fill" points={area} />
      <polyline className="line" points={pts.join(' ')} />
    </svg>
  )
}

// ─── Trigger ──────────────────────────────────────────────────────────────────

interface TriggerProps {
  cpuPercent: number | null
  active:     number
  onClick:    () => void
}

export function SystemMonitorTrigger({ cpuPercent, active, onClick }: TriggerProps) {
  return (
    <button className="sysmon-trigger" onClick={onClick} title="system monitor">
      <span className="glyph"><Icon name="cpu" size={12} /></span>
      <span className="pct">{cpuPercent == null ? '—' : `${Math.round(cpuPercent)}%`}</span>
      {active > 0 && <span className="count">{active}</span>}
    </button>
  )
}

// ─── Workspace grouping ────────────────────────────────────────────────────────

interface ProcRow {
  key:      string
  kind:     'bridge' | 'pty'
  name:     string
  sub:      string
  agentId:  string | null
  cpu:      number | null
  memBytes: number | null
  onOpen:   () => void
  onKill:   () => void
}

interface WsGroup {
  wsId: string
  name: string
  rows: ProcRow[]
}

const OTHER_WS = '__other__'

// Tab ids are workspace-prefixed (`${wsId}` or `${wsId}-…`), so a bridge's
// session key resolves back to its workspace by prefix match.
function resolveWsId(tabId: string, workspaces: MonitorWorkspace[]): string {
  const w = workspaces.find(w => tabId === w.id || tabId.startsWith(`${w.id}-`))
  return w?.id ?? OTHER_WS
}

interface GroupActions {
  onKillTerminal: (id: string) => void
  onStopDaemon:   (bridgeId: string) => void
  onOpenTerminal: (tabId: string, wsId: string) => void
  onOpenDaemon:   (sessionKey: string) => void
}

function buildGroups(
  terminals:  TerminalDaemon[],
  samples:    ProcessSample[],
  workspaces: MonitorWorkspace[],
  actions:    GroupActions,
): WsGroup[] {
  const { onKillTerminal, onStopDaemon, onOpenTerminal, onOpenDaemon } = actions
  const byPty    = new Map(samples.filter(s => s.kind === 'pty').map(s => [s.id, s]))
  const groups   = new Map<string, WsGroup>()
  const nameOf   = (wsId: string) =>
    wsId === OTHER_WS ? 'other' : (workspaces.find(w => w.id === wsId)?.name ?? wsId)
  const ensure = (wsId: string): WsGroup => {
    let g = groups.get(wsId)
    if (!g) { g = { wsId, name: nameOf(wsId), rows: [] }; groups.set(wsId, g) }
    return g
  }

  // Terminals — workspace is known directly; stats joined from the pty sample.
  for (const t of terminals) {
    const s = byPty.get(t.id)
    ensure(t.wsId).rows.push({
      key:      `pty:${t.id}`,
      kind:     'pty',
      name:     t.title,
      sub:      t.sub,
      agentId:  t.agentId,
      cpu:      s ? s.cpu : null,
      memBytes: s ? s.memBytes : null,
      onOpen:   () => onOpenTerminal(t.tabId, t.wsId),
      onKill:   () => onKillTerminal(t.id),
    })
  }

  // Daemons (agent bridges) — workspace resolved from the session key's tab id.
  for (const s of samples) {
    if (s.kind !== 'bridge') continue
    const tabId = s.sessionKey ? s.sessionKey.split(':')[0] : ''
    const wsId  = resolveWsId(tabId, workspaces)
    ensure(wsId).rows.push({
      key:      `bridge:${s.id}`,
      kind:     'bridge',
      name:     s.provider ?? 'agent',
      sub:      s.sessionKey ?? s.id,
      agentId:  s.sessionKey ? s.sessionKey.split(':')[1] ?? null : null,
      cpu:      s.cpu,
      memBytes: s.memBytes,
      onOpen:   () => { if (s.sessionKey) onOpenDaemon(s.sessionKey) },
      onKill:   () => onStopDaemon(s.id),
    })
  }

  // Stable order: known workspaces first (by name), "other" last.
  return [...groups.values()].sort((a, b) => {
    if (a.wsId === OTHER_WS) return 1
    if (b.wsId === OTHER_WS) return -1
    return a.name.localeCompare(b.name)
  })
}

// ─── Mount ────────────────────────────────────────────────────────────────────
//
// Owns the polling hook and open state so the stat ticks re-render only this
// subtree, not the whole App.

interface SystemMonitorMountProps {
  terminals:      TerminalDaemon[]
  workspaces:     MonitorWorkspace[]
  onKillTerminal: (id: string) => void
  onOpenTerminal: (tabId: string, wsId: string) => void
  onOpenDaemon:   (sessionKey: string) => void
}

// Memoized: App passes only stable props (useMemo/useCallback), so this bails
// out of App's per-token re-renders and updates only on its own 2s stat ticks.
export const SystemMonitorMount = memo(function SystemMonitorMount({
  terminals, workspaces, onKillTerminal, onOpenTerminal, onOpenDaemon,
}: SystemMonitorMountProps) {
  const [open, setOpen] = useState(false)
  const monitor = useSystemStats(open)
  const active = terminals.length + (monitor.stats?.bridgeCount ?? 0)

  // Navigating to a process closes the panel so the focused surface is visible.
  const openTerminal = (tabId: string, wsId: string) => { onOpenTerminal(tabId, wsId); setOpen(false) }
  const openDaemon   = (sessionKey: string) => { onOpenDaemon(sessionKey); setOpen(false) }

  return (
    <>
      <SystemMonitorTrigger
        cpuPercent={monitor.stats?.cpuPercent ?? null}
        active={active}
        onClick={() => setOpen(o => !o)}
      />
      <SystemMonitor
        open={open}
        onClose={() => setOpen(false)}
        monitor={monitor}
        terminals={terminals}
        workspaces={workspaces}
        onKillTerminal={onKillTerminal}
        onOpenTerminal={openTerminal}
        onOpenDaemon={openDaemon}
      />
    </>
  )
})

// ─── Popover ──────────────────────────────────────────────────────────────────

interface SystemMonitorProps {
  open:           boolean
  onClose:        () => void
  monitor:        SystemStatsState
  terminals:      TerminalDaemon[]
  workspaces:     MonitorWorkspace[]
  onKillTerminal: (id: string) => void
  onOpenTerminal: (tabId: string, wsId: string) => void
  onOpenDaemon:   (sessionKey: string) => void
}

function SystemMonitor({
  open, onClose, monitor, terminals, workspaces, onKillTerminal, onOpenTerminal, onOpenDaemon,
}: SystemMonitorProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Collapsed workspace groups, keyed by wsId. Persists across open/close since
  // the component stays mounted (it just renders null while closed).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    const t = setTimeout(() => document.addEventListener('mousedown', fn), 0)
    document.addEventListener('keydown', esc)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', fn)
      document.removeEventListener('keydown', esc)
    }
  }, [open, onClose])

  const { stats, processes, cpuHist, memHist, refresh, stopDaemon } = monitor

  const samples = processes?.processes ?? []
  const groups = useMemo(
    () => buildGroups(terminals, samples, workspaces, {
      onKillTerminal, onStopDaemon: stopDaemon, onOpenTerminal, onOpenDaemon,
    }),
    [terminals, samples, workspaces, onKillTerminal, stopDaemon, onOpenTerminal, onOpenDaemon],
  )
  const toggleGroup = (wsId: string) => setCollapsed(prev => ({ ...prev, [wsId]: !prev[wsId] }))

  if (!open) return null

  // Prefer the richer process totals (app + children) once they've loaded.
  // combinedCpu is per-core (100% = one full core); divide by cores to show a
  // task-manager-style share of the whole machine (all cores = 100%).
  const combinedCpu = processes?.combinedCpu ?? stats?.cpuPercent ?? 0
  const trackedMem  = processes?.trackedMemBytes ?? stats?.appMemBytes ?? 0
  const memTotal    = stats?.memTotal ?? 0
  const ramPct      = memTotal > 0 ? (trackedMem / memTotal) * 100 : 0
  const cores       = stats?.cores ?? 1
  const daemonCount = samples.filter(s => s.kind === 'bridge').length

  return (
    <div className="sysmon" ref={ref}>
      <div className="sysmon-h">
        <span className="logo"><Icon name="cpu" size={13} /></span>
        <span className="t">system</span>
        {stats && <span className="sub">{cores} cores · up {formatUptime(stats.uptime)}</span>}
        <span className="right">
          <button title="refresh" onClick={refresh}><Icon name="refresh" size={12} /></button>
          <button title="close" onClick={onClose}><Icon name="close" size={12} /></button>
        </span>
      </div>

      {/* CPU + memory cards */}
      <div className="sysmon-cards">
        <div className="sysmon-card">
          <div className="lbl">cpu · crewcode</div>
          <div className="val">{stats ? `${(combinedCpu / cores).toFixed(1)}%` : '—'}</div>
          <Sparkline data={cpuHist} max={cores * 100} tone="cpu" />
          <div className="meta">crewcode + processes</div>
        </div>
        <div className="sysmon-card">
          <div className="lbl">memory</div>
          <div className="val">{stats ? formatBytes(trackedMem) : '—'}</div>
          <Sparkline data={memHist} max={1} tone="mem" />
          <div className="meta">crewcode + terminals</div>
        </div>
      </div>

      {/* System RAM meter */}
      {stats && (
        <div className="sysmon-ram">
          <div className="ram-h">
            <span className="k">system ram</span>
            <span className="v">{ramPct < 1 ? ramPct.toFixed(1) : Math.round(ramPct)}% of {formatBytes(memTotal)}</span>
          </div>
          <div className="ram-bar"><span style={{ width: `${Math.min(100, ramPct)}%` }} /></div>
        </div>
      )}

      {/* Counts strip */}
      <div className="sysmon-counts">
        <div className="stat">
          <Icon name="terminal" size={12} />
          <span className="n">{terminals.length}</span>
          <span className="k">terminals</span>
        </div>
        <div className="stat">
          <Icon name="server" size={12} />
          <span className="n">{daemonCount || (stats?.bridgeCount ?? 0)}</span>
          <span className="k">daemons</span>
        </div>
      </div>

      {/* Per-workspace process groups */}
      <div className="sysmon-body">
        {groups.length === 0 ? (
          <div className="sysmon-empty">no processes running</div>
        ) : (
          groups.map(g => {
            const isCollapsed = !!collapsed[g.wsId]
            return (
              <div className="sysmon-group" key={g.wsId}>
                <button
                  className="sysmon-sec"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(g.wsId)}
                >
                  <Icon className="chev" name={isCollapsed ? 'chevRight' : 'chevDown'} size={12} />
                  <Icon name="folder" size={11} />
                  <span className="ws-name">{g.name}</span>
                  <span className="ct">{g.rows.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="sysmon-list">
                    {g.rows.map(r => (
                      <div className="sysmon-row" key={r.key} onClick={r.onOpen} title="jump to process">
                        <span className={`dot ${r.kind === 'bridge' ? 'live' : r.agentId ? 'agent' : ''}`} />
                        <div className="rt">
                          <div className="name">
                            {r.name}
                            <span className="kind">{r.kind === 'bridge' ? 'daemon' : 'terminal'}</span>
                          </div>
                          <div className="rsub">{r.sub}</div>
                        </div>
                        <span className="usage">
                          <span className="cpu">{r.cpu == null ? '—' : `${Math.round(r.cpu)}%`}</span>
                          <span className="mem">{r.memBytes == null ? '—' : formatBytes(r.memBytes)}</span>
                        </span>
                        <button
                          className="kill"
                          title={r.kind === 'bridge' ? 'stop daemon' : 'kill terminal'}
                          onClick={(e) => { e.stopPropagation(); r.onKill() }}
                        >
                          <Icon name="x" size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
