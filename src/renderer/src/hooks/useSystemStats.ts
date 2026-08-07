/**
 * useSystemStats — feeds the system monitor.
 *
 * Two cadences:
 *  - `system:stats` polls continuously (cheap, no child spawns) so the trigger
 *    pill always shows CrewCode's live combined CPU.
 *  - `system:processes` polls only while the panel is open — it samples every
 *    spawned terminal/daemon process tree (via pidusage/pidtree in main), which
 *    is heavier, so it's gated on `open`.
 *
 * Short ring buffers of CPU and memory drive the sparklines. They prefer the
 * richer process totals when the panel is open and fall back to the app-only
 * figures otherwise.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { SystemStatsSnapshot, SystemProcessesSnapshot } from '../types'

const HISTORY      = 32
const STATS_MS     = 2000
const PROCESSES_MS = 1500

export interface SystemStatsState {
  stats:      SystemStatsSnapshot | null
  processes:  SystemProcessesSnapshot | null
  cpuHist:    number[]   // combined CPU %, may exceed 100
  memHist:    number[]   // tracked memory as a fraction of physical RAM (0..1)
  refresh:    () => void
  stopDaemon: (bridgeId: string) => Promise<void>
}

export function useSystemStats(open: boolean): SystemStatsState {
  const [stats,     setStats]     = useState<SystemStatsSnapshot | null>(null)
  const [processes, setProcesses] = useState<SystemProcessesSnapshot | null>(null)
  const [cpuHist,   setCpuHist]   = useState<number[]>([])
  const [memHist,   setMemHist]   = useState<number[]>([])

  const aliveRef    = useRef(true)
  const statsBusy   = useRef(false)
  const procBusy    = useRef(false)
  // The latest snapshots, so the history push can prefer process totals without
  // re-subscribing the pollers on every tick.
  const statsRef    = useRef<SystemStatsSnapshot | null>(null)
  const procRef     = useRef<SystemProcessesSnapshot | null>(null)
  const openRef     = useRef(open)
  openRef.current   = open

  const pushHistory = useCallback(() => {
    const s = statsRef.current
    if (!s) return
    const p = openRef.current ? procRef.current : null
    const cpu = p ? p.combinedCpu : s.cpuPercent
    const mem = (p ? p.trackedMemBytes : s.appMemBytes) / (s.memTotal || 1)
    setCpuHist(prev => [...prev, cpu].slice(-HISTORY))
    setMemHist(prev => [...prev, mem].slice(-HISTORY))
  }, [])

  const pollStats = useCallback(async () => {
    const api = window.electronAPI
    if (!api || statsBusy.current) return
    statsBusy.current = true
    try {
      const s = await api.systemStats()
      if (!aliveRef.current) return
      statsRef.current = s
      setStats(s)
      // When the panel is closed, the stats tick drives the sparklines.
      if (!openRef.current) pushHistory()
    } catch { /* main not ready — skip */ }
    finally { statsBusy.current = false }
  }, [pushHistory])

  const pollProcesses = useCallback(async () => {
    const api = window.electronAPI
    if (!api || procBusy.current) return
    procBusy.current = true
    try {
      const p = await api.systemProcesses()
      if (!aliveRef.current) return
      procRef.current = p
      setProcesses(p)
      pushHistory()
    } catch { /* skip */ }
    finally { procBusy.current = false }
  }, [pushHistory])

  // Continuous cheap stats.
  useEffect(() => {
    aliveRef.current = true
    pollStats()
    const t = setInterval(pollStats, STATS_MS)
    return () => { aliveRef.current = false; clearInterval(t) }
  }, [pollStats])

  // Heavy per-process sampling — only while open.
  useEffect(() => {
    if (!open) { setProcesses(null); procRef.current = null; return }
    pollProcesses()
    const t = setInterval(pollProcesses, PROCESSES_MS)
    return () => clearInterval(t)
  }, [open, pollProcesses])

  const refresh = useCallback(() => {
    pollStats()
    if (openRef.current) pollProcesses()
  }, [pollStats, pollProcesses])

  const stopDaemon = useCallback(async (bridgeId: string) => {
    await window.electronAPI?.systemStopDaemon(bridgeId)
    setProcesses(prev => prev ? { ...prev, processes: prev.processes.filter(p => p.id !== bridgeId) } : prev)
    pollProcesses()
  }, [pollProcesses])

  return { stats, processes, cpuHist, memHist, refresh, stopDaemon }
}
