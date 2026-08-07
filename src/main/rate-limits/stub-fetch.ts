import type { ProviderRateLimits } from '../../shared/rate-limit-types'

export function unavailableProvider(provider: string): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Rate limits not available for this provider',
    status: 'unavailable',
  }
}
