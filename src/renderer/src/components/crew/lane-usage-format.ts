/**
 * Compact formatters for the lane usage strip. Token counts compress to "1.2k"
 * past a thousand; elapsed time uses h/m/s with one decimal under a minute so
 * a freshly-running lane shows movement instead of jumping 0s → 1s.
 */

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1_000) return String(Math.floor(n))
  if (n < 100_000) return (n / 1_000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  if (n < 1_000_000) return Math.floor(n / 1_000) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const s = ms / 1000
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's'
  const m = s / 60
  if (m < 60) return Math.floor(m) + 'm ' + Math.floor(s - Math.floor(m) * 60) + 's'
  const h = m / 60
  return Math.floor(h) + 'h ' + Math.floor(m - Math.floor(h) * 60) + 'm'
}
