/**
 * useProviderModels — resolves the selectable model list for an agent provider.
 *
 * Providers that expose a CLI/server model list are queried live first. The
 * static FALLBACK_CATALOG is used only after that query returns empty or fails.
 * Shared by ModelPicker (the dropdown) and ModelRow (⌘⇧M cycling) so both
 * agree on ordering and the "default" sentinel.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

export interface DetectedModel {
  id:            string
  label:         string
  provider:      string
  contextWindow?: number
}

// Providers whose model list comes from the running CLI/server. Codex's
// app-server list includes legacy/server-advertised models, so its curated
// catalog below is authoritative for the picker.
const DYNAMIC_PROVIDERS = new Set(['pi', 'opencode', 'claude', 'hermes', 'crewcoder', 'grok', 'ollama', 'openrouter'])
const detectedModelCache = new Map<string, DetectedModel[]>()
const detectedModelRequests = new Map<string, Promise<DetectedModel[]>>()

// Static fallback catalog used when the CLI doesn't expose a list (or isn't installed).
export const FALLBACK_CATALOG: Record<string, DetectedModel[]> = {
  'opencode-go': [
    { id: 'minimax-m3', label: 'MiniMax M3', provider: 'opencode-go' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'opencode-go' },
    { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', provider: 'opencode-go' },
    { id: 'glm-5.2', label: 'GLM 5.2', provider: 'opencode-go' },
    { id: 'qwen3.7-plus', label: 'Qwen 3.7 Plus', provider: 'opencode-go' },
  ],
  pi: [
    { id: '',                            label: 'default (CLI default)', provider: 'pi' },
    { id: 'opencode-go/kimi-2.6',        label: 'Kimi 2.6',              provider: 'pi' },
    { id: 'claude-sonnet-4-6',           label: 'Sonnet 4.6',            provider: 'anthropic' },
    { id: 'openai/gpt-5.5',              label: 'GPT-5.5',               provider: 'openai' },
    { id: 'openai/gpt-5.4',              label: 'GPT-5.4',               provider: 'openai' },
    { id: 'opencode-go/kimi-2.6',        label: 'Kimi 2.6',              provider: 'opencode-go' },
  ],
  opencode: [
    { id: '', label: 'default (server choice)', provider: 'opencode' },
  ],
  crewcoder: [
    { id: '', label: 'default (CrewCoder config)', provider: 'crewcoder' },
  ],
  claude: [
    { id: '',                       label: 'default (CLI default)', provider: 'anthropic' },
   //  { id: 'fable',                  label: 'Fable (latest)',        provider: 'anthropic' },
    { id: 'claude-sonnet-5',      label: 'Claude Sonnet 4.6 (latest)',     provider: 'anthropic', contextWindow: 500_000 },
    { id: 'claude-opus-4-8',        label: 'Claude Opus 4.8 (latest)',       provider: 'anthropic', contextWindow: 500_000 },
    { id: 'claude-haiku-4-5',       label: 'Claude Haiku 4.5 (latest)',      provider: 'anthropic', contextWindow: 200_000 },  ],
  codex: [
    { id: '',              label: 'default (CLI default)', provider: 'codex' },
    { id: 'gpt-5.6-sol',       label: 'GPT-5.6 Sol',               provider: 'codex' },
    { id: 'gpt-5.6-terra',       label: 'GPT-5.6 Terra',               provider: 'codex' },
    { id: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna',          provider: 'codex' },
    { id: 'gpt-5.5',       label: 'GPT-5.5',               provider: 'codex' },
    { id: 'gpt-5.4',       label: 'GPT-5.4',               provider: 'codex' },
    { id: 'gpt-5.4-mini',  label: 'GPT-5.4 Mini',          provider: 'codex' },
  ],
  // Shown only when the Ollama server is unreachable; otherwise /api/tags wins.
  ollama: [
    { id: 'llama3.2',    label: 'llama3.2 (pull first)',    provider: 'ollama' },
    { id: 'qwen2.5',     label: 'qwen2.5 (pull first)',     provider: 'ollama' },
    { id: 'deepseek-r1', label: 'deepseek-r1 (pull first)', provider: 'ollama' },
  ],
  // Shown only if the OpenRouter catalog fetch fails; otherwise /models wins.
  openrouter: [
    { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
    { id: 'openai/gpt-5.5',              label: 'GPT-5.5',           provider: 'openai' },
    { id: 'openai/gpt-5.4',              label: 'GPT-5.4',           provider: 'openai' },
    { id: 'google/gemini-2.5-pro',       label: 'Gemini 2.5 Pro',    provider: 'google' },
  ],
}

export interface ProviderModels {
  list:    DetectedModel[]
  /** True while detected models include live CLI/server results (not fallback). */
  hasDetected: boolean
  loading: boolean
}

/**
 * Model ids currently known for a provider, read synchronously from the detection
 * cache with the static catalog as fallback. Used by delegation to validate a
 * spawn's requested model without awaiting a fetch — an empty result means "we
 * can't validate", not "no models exist".
 */
export function knownModelIds(provider: string): string[] {
  const detected = detectedModelCache.get(provider) ?? []
  const source = detected.length > 0 ? detected : (FALLBACK_CATALOG[provider] ?? [])
  return source.map(m => m.id).filter(id => id.length > 0)
}

export function prefetchProviderModels(provider: string, force = false): Promise<DetectedModel[]> {
  if (!DYNAMIC_PROVIDERS.has(provider)) return Promise.resolve([])
  const pending = detectedModelRequests.get(provider)
  if (!force && pending) return pending
  const cached = detectedModelCache.get(provider)
  if (!force && cached) return Promise.resolve(cached)
  const api = window.electronAPI
  if (!api) return Promise.resolve([])
  const request = api.agentListModels(provider)
    .then(models => {
      const next = models ?? []
      detectedModelCache.set(provider, next)
      return next
    })
    .catch(() => {
      detectedModelCache.set(provider, [])
      return []
    })
    .finally(() => {
      if (detectedModelRequests.get(provider) === request) detectedModelRequests.delete(provider)
    })
  detectedModelRequests.set(provider, request)
  return request
}

/**
 * @param enabled set false to skip the live fetch (e.g. when the list is
 *        supplied from a parent that already fetched it).
 */
export function useProviderModels(provider: string, enabled = true, refreshKey: unknown = 0): ProviderModels {
  const [detected, setDetected] = useState<DetectedModel[] | null>(() => detectedModelCache.get(provider) ?? null)
  const [loading,  setLoading]  = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const retryCounts = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!enabled || !DYNAMIC_PROVIDERS.has(provider)) { setDetected(null); return }
    let cancelled = false
    const cached = detectedModelCache.get(provider)
    setDetected(cached ?? null)
    setLoading(true)
    prefetchProviderModels(provider, Boolean(refreshKey))
      .then(next => {
        if (cancelled) return
        setDetected(next)
        if (next.length === 0 && (retryCounts.current[provider] ?? 0) < 3) {
          retryCounts.current[provider] = (retryCounts.current[provider] ?? 0) + 1
          setTimeout(() => { if (!cancelled) setRetryTick(t => t + 1) }, 2_000)
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [provider, enabled, retryTick, refreshKey])

  const list = useMemo<DetectedModel[]>(() => {
    if (DYNAMIC_PROVIDERS.has(provider)) {
      if (detected === null) return []
      if (detected.length > 0) {
        // Ollama / OpenRouter require an explicit model (no server-side default),
        // so don't offer the empty "default" sentinel — only the detected list.
        if (provider === 'ollama' || provider === 'openrouter') return detected
        return [{ id: '', label: 'default (CLI default)', provider }, ...detected]
      }
      return FALLBACK_CATALOG[provider] ?? []
    }
    return FALLBACK_CATALOG[provider] ?? []
  }, [provider, detected])

  return { list, hasDetected: !!detected && detected.length > 0, loading }
}
