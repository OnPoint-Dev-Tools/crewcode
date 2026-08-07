import os from 'os'
import { app, ipcMain } from 'electron'
import pidusage from 'pidusage'
import pidtree from 'pidtree'
import { ptyProcessCount, listPtyDaemons } from './pty'
import { listBridgeDaemons, stopBridgeDaemon } from './agents'

// The system monitor splits its data into two channels:
//
//   system:stats     — cheap, polled continuously for the live trigger pill.
//                      Uses Electron's app.getAppMetrics() (no child spawns) for
//                      CrewCode's own combined CPU + memory footprint.
//
//   system:processes — heavier, polled only while the panel is open. Samples
//                      every spawned process (terminals + agent daemons) AND
//                      their child trees via pidusage/pidtree to attribute real
//                      per-process CPU and resident memory, grouped downstream
//                      by workspace.

// ─── Cheap snapshot (CrewCode's own footprint) ───────────────────────────────

export interface SystemStatsSnapshot {
  cpuPercent:   number   // CrewCode combined CPU load; >100% = more than one core busy
  cores:        number
  memTotal:     number   // physical RAM, bytes
  appMemBytes:  number   // CrewCode's own resident memory, bytes
  uptime:       number   // OS uptime, seconds
  platform:     NodeJS.Platform
  bridgeCount:  number
  ptyProcCount: number
}

function statsSnapshot(): SystemStatsSnapshot {
  let appCpu = 0
  let appMem = 0
  for (const m of app.getAppMetrics()) {
    appCpu += m.cpu?.percentCPUUsage ?? 0
    appMem += (m.memory?.workingSetSize ?? 0) * 1024  // workingSetSize is KB
  }
  return {
    cpuPercent:   appCpu,
    cores:        os.cpus().length,
    memTotal:     os.totalmem(),
    appMemBytes:  appMem,
    uptime:       os.uptime(),
    platform:     process.platform,
    bridgeCount:  listBridgeDaemons().length,
    ptyProcCount: ptyProcessCount(),
  }
}

// ─── Detailed per-process snapshot ────────────────────────────────────────────

export interface ProcessSample {
  kind:       'bridge' | 'pty'
  id:         string              // bridgeId or paneId — the renderer joins this to a workspace
  pid:        number
  cpu:        number              // % (100 = one full core); summed over the process tree
  memBytes:   number              // resident memory summed over the process tree
  provider?:  string              // bridges only
  sessionKey?: string | null      // bridges only — "tabId:agentId"
  startedAt?: number              // bridges only
}

export interface SystemProcessesSnapshot {
  appCpu:          number
  appMemBytes:     number
  processes:       ProcessSample[]
  combinedCpu:     number   // app + every tracked process
  trackedMemBytes: number   // app + every tracked process
}

/** Root pid plus its descendants — so a shell's children (npm, node, …) count too. */
async function processTree(rootPid: number): Promise<number[]> {
  try {
    const kids = await pidtree(rootPid)
    return [rootPid, ...kids]
  } catch {
    return [rootPid]
  }
}

type Usage = Record<number, { cpu: number; memory: number }>

/** Sample a batch of pids, tolerating any that vanish mid-sample. */
async function sampleUsage(pids: number[]): Promise<Usage> {
  if (pids.length === 0) return {}
  try {
    return (await pidusage(pids)) as Usage
  } catch {
    // A pid exited between collection and sampling — keep whatever survives.
    const out: Usage = {}
    await Promise.all(pids.map(async pid => {
      try { Object.assign(out, await pidusage(pid)) } catch { /* gone */ }
    }))
    return out
  }
}

interface Root {
  kind:       'bridge' | 'pty'
  id:         string
  pid:        number
  tree:       number[]
  provider?:  string
  sessionKey?: string | null
  startedAt?: number
}

async function processesSnapshot(): Promise<SystemProcessesSnapshot> {
  const appPids = app.getAppMetrics().map(m => m.pid)

  const roots: Root[] = []
  for (const b of listBridgeDaemons()) {
    if (b.pid == null) continue
    roots.push({
      kind: 'bridge', id: b.bridgeId, pid: b.pid, tree: await processTree(b.pid),
      provider: b.provider, sessionKey: b.sessionKey, startedAt: b.startedAt,
    })
  }
  for (const p of listPtyDaemons()) {
    roots.push({ kind: 'pty', id: p.paneId, pid: p.pid, tree: await processTree(p.pid) })
  }

  const allPids = Array.from(new Set([...appPids, ...roots.flatMap(r => r.tree)]))
  const usage = await sampleUsage(allPids)

  const aggregate = (pids: number[]) => pids.reduce(
    (acc, pid) => {
      const u = usage[pid]
      if (u) { acc.cpu += u.cpu; acc.mem += u.memory }
      return acc
    },
    { cpu: 0, mem: 0 },
  )

  const appAgg = aggregate(appPids)
  const processes: ProcessSample[] = roots.map(r => {
    const agg = aggregate(r.tree)
    return {
      kind: r.kind, id: r.id, pid: r.pid, cpu: agg.cpu, memBytes: agg.mem,
      provider: r.provider, sessionKey: r.sessionKey, startedAt: r.startedAt,
    }
  })

  return {
    appCpu:          appAgg.cpu,
    appMemBytes:     appAgg.mem,
    processes,
    combinedCpu:     appAgg.cpu + processes.reduce((s, p) => s + p.cpu, 0),
    trackedMemBytes: appAgg.mem + processes.reduce((s, p) => s + p.memBytes, 0),
  }
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

export function registerSystemStatsIpc(): void {
  ipcMain.handle('system:stats', () => statsSnapshot())
  ipcMain.handle('system:processes', () => processesSnapshot())
  ipcMain.handle('system:stopDaemon', (_e, bridgeId: string) => stopBridgeDaemon(bridgeId))
}
