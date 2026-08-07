import { useEffect, useState } from 'react'

// Compact "since" label for a completed chat: "now" under a minute, then
// "12m" / "3h" / "2d". Kept intentionally terse so it fits the drawer's
// ws-meta / sess rows without wrapping.
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  return `${day}d`
}

// Ticking wall clock so elapsed badges advance on their own. 30s cadence is
// enough for minute-granular labels and keeps re-renders cheap.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
