const SOFT_SEGMENT_LIMIT = 220
const HARD_CHUNK_LIMIT = 180

/**
 * Keep streamed text in readable chronological chunks instead of one growing
 * paragraph; deltas are often token-sized, so small fragments are coalesced.
 */
export function appendStreamChunk(chunks: string[] | undefined, delta: string): string[] {
  if (!delta) return chunks ?? []
  const next = chunks ? chunks.slice() : []
  if (next.length === 0) return [delta]

  const last = next[next.length - 1]
  const startsNewLine = /^\s*\r?\n/.test(delta)
  const lastEndedUnit = /(?:[.!?。！？:]|\r?\n)\s*$/.test(last)
  const deltaContainsBreak = /\r?\n/.test(delta)

  if (startsNewLine || lastEndedUnit || deltaContainsBreak || last.length >= HARD_CHUNK_LIMIT) {
    next.push(delta)
  } else {
    next[next.length - 1] = last + delta
  }
  return next
}

function pushWrapped(out: string[], value: string): void {
  let rest = value.trim()
  while (rest.length > SOFT_SEGMENT_LIMIT) {
    const slice = rest.slice(0, SOFT_SEGMENT_LIMIT)
    const breakAt = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '), slice.lastIndexOf('; '), slice.lastIndexOf(', '), slice.lastIndexOf(' '))
    const idx = breakAt > 40 ? breakAt + 1 : SOFT_SEGMENT_LIMIT
    out.push(rest.slice(0, idx).trim())
    rest = rest.slice(idx).trim()
  }
  if (rest) out.push(rest)
}

function splitChronologicalUnits(value: string): string[] {
  const normalized = value.replace(/\r\n/g, '\n')
  const out: string[] = []
  for (const rawLine of normalized.split(/\n+/)) {
    const line = rawLine.trim()
    if (!line) continue

    const sentenceParts = line.split(/(?<=[.!?。！？])\s+(?=[A-Z0-9_`*\-])/)
    if (sentenceParts.length > 1) {
      for (const part of sentenceParts) pushWrapped(out, part)
    } else {
      pushWrapped(out, line)
    }
  }
  return out
}

/**
 * Split results cached by chunk text. A streaming block re-renders on every
 * flush (~20x/sec) and re-split ALL of its accumulated chunks each time, making
 * the work quadratic in turn length — the visible hitch as long thinking blocks
 * grow. Only the final chunk actually changes between flushes, so completed
 * chunks hit this cache and re-splitting collapses to the tail.
 *
 * Bounded because keys are the chunk strings themselves; on overflow the whole
 * cache is dropped rather than tracking per-entry recency (a rebuild is one
 * split per visible chunk, and streaming keeps the hot chunks warm anyway).
 */
const MAX_SPLIT_CACHE_ENTRIES = 512
const splitCache = new Map<string, string[]>()

function splitChronologicalUnitsCached(value: string): string[] {
  const cached = splitCache.get(value)
  if (cached) return cached
  const units = splitChronologicalUnits(value)
  if (splitCache.size >= MAX_SPLIT_CACHE_ENTRIES) splitCache.clear()
  splitCache.set(value, units)
  return units
}

export function chronologicalStreamSegments(chunks: string[] | undefined, fallbackText: string): string[] {
  const source = chunks && chunks.length > 0 ? chunks : [fallbackText]
  const segments: string[] = []
  for (const chunk of source) {
    // push(...units) spreads every segment as an argument — a long block can
    // exceed the engine's argument limit and throws. Append in a loop instead.
    for (const unit of splitChronologicalUnitsCached(chunk)) segments.push(unit)
  }
  return segments.length > 0 ? segments : [' ']
}
