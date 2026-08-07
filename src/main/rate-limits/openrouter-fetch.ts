import { net } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { getAgentKey } from '../agents/agent-keys'

const API_TIMEOUT_MS = 10_000

export async function fetchOpenRouterRateLimits(): Promise<ProviderRateLimits> {
  const key = getAgentKey('openrouter')
  if (!key) {
    return {
      provider: 'openrouter',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'No API key set',
      status: 'unavailable',
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    // OpenRouter auth/key endpoint returns credit usage info
    const res = await net.fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`OpenRouter API returned ${res.status}`)
    }

    const data = (await res.json()) as {
      data?: {
        usage?: number
        limit?: number | null
        limit_remaining?: number | null
      }
    }

    const usage = data.data?.usage ?? 0
    const limit = data.data?.limit ?? null
    const remaining = data.data?.limit_remaining ?? null

    let usedPercent = 0
    if (typeof limit === 'number' && limit > 0) {
      usedPercent = Math.min(100, Math.max(0, (usage / limit) * 100))
    } else if (typeof remaining === 'number' && usage + remaining > 0) {
      usedPercent = Math.min(100, Math.max(0, (usage / (usage + remaining)) * 100))
    }

    return {
      provider: 'openrouter',
      session:
        usedPercent > 0
          ? {
              usedPercent,
              windowMinutes: 10080,
              resetsAt: null,
              resetDescription: null,
            }
          : null,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      provider: 'openrouter',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error',
    }
  } finally {
    clearTimeout(timeout)
  }
}
