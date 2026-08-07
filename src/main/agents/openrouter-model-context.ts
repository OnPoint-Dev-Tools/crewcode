import { net } from 'electron'
import type { TurnUsage } from './bridge-types'
import { registerContextWindow, registeredContextWindowFor } from './model-context'

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CATALOG_TTL_MS = 60 * 60 * 1000

type OpenRouterModel = {
  id?: string
  name?: string
  context_length?: number
  top_provider?: {
    context_length?: number
  }
}

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[]
}

let fetchedAt = 0
let pendingFetch: Promise<void> | null = null

function modelContextWindow(model: OpenRouterModel): number | undefined {
  const direct = model.context_length
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct
  const provider = model.top_provider?.context_length
  if (typeof provider === 'number' && Number.isFinite(provider) && provider > 0) return provider
  return undefined
}

async function refreshOpenRouterCatalog(): Promise<void> {
  const response = await net.fetch(OPENROUTER_MODELS_URL)
  if (!response.ok) throw new Error(`OpenRouter model catalog returned ${response.status}`)
  const json = (await response.json()) as OpenRouterModelsResponse
  for (const model of json.data ?? []) {
    const window = modelContextWindow(model)
    registerContextWindow(model.id, window)
    registerContextWindow(model.name, window)
  }
  fetchedAt = Date.now()
}

async function ensureOpenRouterCatalog(): Promise<void> {
  if (Date.now() - fetchedAt < CATALOG_TTL_MS) return
  pendingFetch ??= refreshOpenRouterCatalog().finally(() => { pendingFetch = null })
  await pendingFetch
}

export async function openRouterContextWindowFor(model: string | undefined): Promise<number | undefined> {
  const cached = registeredContextWindowFor(model)
  if (cached) return cached
  if (!model) return undefined
  try {
    await ensureOpenRouterCatalog()
  } catch {
    return undefined
  }
  return registeredContextWindowFor(model)
}

export async function enrichUsageContextWindow(usage: TurnUsage | undefined): Promise<TurnUsage | undefined> {
  if (!usage?.model || usage.contextWindow) return usage
  const contextWindow = await openRouterContextWindowFor(usage.model)
  return contextWindow ? { ...usage, contextWindow } : usage
}
