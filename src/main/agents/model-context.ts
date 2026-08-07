import type { TurnUsage } from './bridge-types'

// Per-model context-window sizes (in tokens). Providers rarely report the
// window on the wire, so the bubble's "context usage" first checks live model
// catalog metadata and only then falls back to conservative family rules.

interface WindowRule {
  match:  RegExp
  window: number
}

const catalogWindows = new Map<string, number>()

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase()
}

function modelSlug(model: string): string {
  return normalizeModelId(model).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function modelLookupKeys(model: string): string[] {
  const normalized = normalizeModelId(model)
  const slash = normalized.lastIndexOf('/')
  const tail = slash === -1 ? normalized : normalized.slice(slash + 1)
  return unique([normalized, tail, modelSlug(normalized), modelSlug(tail)])
}

function significantWords(model: string): string[] {
  return modelSlug(model).split('-').filter(word => word.length > 1)
}

export function registerContextWindow(model: string | undefined, contextWindow: unknown): void {
  if (!model || typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return
  const window = Math.floor(contextWindow)
  for (const key of modelLookupKeys(model)) catalogWindows.set(key, window)
}

export function registeredContextWindowFor(model: string | undefined): number | undefined {
  if (!model) return undefined
  for (const key of modelLookupKeys(model)) {
    const found = catalogWindows.get(key)
    if (found) return found
  }
  const words = significantWords(model)
  if (words.length >= 3) {
    for (const [key, window] of catalogWindows) {
      if (words.every(word => key.includes(word))) return window
    }
  }
  return undefined
}

// Exact CrewCode provider ids win over catalog aliases; broad family rules stay
// fallbacks so provider metadata can refine non-owned model variants.
const EXACT_RULES: WindowRule[] = [
  // The 5.6 family carries the large window; 5.5 and 5.4 do not.
  { match: /^(?:openai\/)?gpt-5\.6-sol$/i, window: 1_050_000 },
  { match: /^(?:openai\/)?gpt-5\.6-terra$/i, window: 1_050_000 },
  { match: /^(?:openai\/)?gpt-5\.6-luna$/i, window: 1_050_000 },
  { match: /^(?:openai\/)?gpt-5\.6$/i, window: 1_050_000 },
  { match: /^(?:openai\/)?gpt-5\.5$/i, window: 400_000 },
  { match: /^(?:openai\/)?gpt-5\.4$/i, window: 400_000 },
  { match: /^(?:openai\/)?gpt-5\.4-mini$/i, window: 200_000 },
]

// Ordered most-specific → least-specific; first hit wins.
const RULES: WindowRule[] = [
  // Claude Code windows vary by family; Opus exposes a larger 1M context.
    { match: /claude-opus-5/i, window: 1_000_000 },
  { match: /claude-sonnet-5/i,                window: 1_000_000 },
  { match: /claude-fable-5/i,                window: 500_000 },
  { match: /claude-opus-4.8/i, window: 500_000 },
  { match: /claude-sonnet-4.6/i,                window: 500_000 },
  { match: /claude-haiku-4-5/i,                window: 200_000 },
  // Google Gemini — 1M (pro variants go to 2M but 1M is the safe floor).
  { match: /gemini-1\.5-pro/i, window: 128_000 },
  { match: /gemini-1\.5-flash/i, window: 200_000 },
  { match: /gemini-2\.5-pro/i, window: 1_000_000 },
  { match: /gemini-2\.5-flash/i, window: 200_000 },
  { match: /gemini-3-flash/i,                window: 200_000 },
  { match: /gemini-3-pro/i,                window: 1_000_000 },
  { match: /gemini-3-deep-think/i,                window: 1_000_000 },
  // Open-weight providers vary wildly by host/version, so require catalog metadata instead of guessing.
]

/**
 * Best-effort context-window size for a model id. Returns undefined when no
 * provider-reported/catalog/static metadata is known so the UI does not render
 * a fabricated context percentage.
 */
export function contextWindowFor(model: string | undefined): number | undefined {
  if (!model) return undefined
  for (const rule of EXACT_RULES) {
    if (rule.match.test(model)) return rule.window
  }
  const registered = registeredContextWindowFor(model)
  if (registered) return registered
  // Family rules are written hyphenated, but ids arrive as display names too
  // ("Claude Opus 4.8 (latest)"), so match the slug as well or those render no
  // context percentage at all.
  const slug = modelSlug(model)
  for (const rule of RULES) {
    if (rule.match.test(model) || rule.match.test(slug)) return rule.window
  }
  return undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Assemble a TurnUsage from raw input/output counts, deriving the total and
 * the context window. `contextTokens` defaults to input+output since a turn's
 * input already carries the full conversation history. Returns undefined when
 * neither count is known, so a bridge that can't see usage emits nothing.
 */
export function buildUsage(opts: {
  inputTokens?:   unknown
  outputTokens?:  unknown
  contextTokens?: unknown
  contextWindow?: unknown
  model?:         string
}): TurnUsage | undefined {
  const inputTokens  = num(opts.inputTokens)
  const outputTokens = num(opts.outputTokens)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const totalTokens   = (inputTokens ?? 0) + (outputTokens ?? 0)
  const contextTokens = num(opts.contextTokens) ?? totalTokens
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    contextTokens,
    contextWindow: num(opts.contextWindow) ?? contextWindowFor(opts.model),
    model:         opts.model,
  }
}
