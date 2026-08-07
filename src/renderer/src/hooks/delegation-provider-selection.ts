// Validates the `agentId`/`model` a delegating agent asks for against the live
// provider registry, and projects that registry into the list the agent sees.
//
// Rejections deliberately name the valid options. An agent that gets back
// `unknown provider "gpt-luna"; available: claude, codex, ollama` self-corrects on
// the next attempt; a bare "invalid provider" makes it retry the same call or give
// up and report a vague failure to the user.

import type { DelegationProviderInfo } from '../../../shared/delegation-types'
import type { AgentInfo } from '../types'

/** Models listed per provider in the injected context. The full OpenRouter
 *  catalogue is thousands of entries — enough to blow the preamble budget on its
 *  own, so context gets a sample and `GET /v1/providers` gets the rest. */
export const CONTEXT_MODELS_PER_PROVIDER = 12

export interface ProviderSelection {
  agentId: string
  model: string
}

export interface SelectionError {
  status: number
  error: string
}

export function isSelectionError(value: unknown): value is SelectionError {
  return !!value && typeof value === 'object' && 'status' in value && 'error' in value
}

/** Why a provider that exists still can't run a thread. */
function unavailableReason(agent: AgentInfo): string | undefined {
  if (agent.available) return undefined
  if (agent.requiresApiKey && !agent.hasKey) return 'no API key configured'
  if (!agent.path) return 'binary not found in PATH'
  return 'not available'
}

/**
 * Project the registry for `GET /v1/providers`. Unavailable providers are listed
 * *with their reason* rather than hidden: an agent that can see why OpenRouter is
 * unusable can tell the user to add a key, instead of silently picking something
 * else and leaving the user wondering why they got a different model.
 */
export function describeProviders(
  agents: AgentInfo[],
  modelsFor: (agentId: string) => string[],
  defaultModelFor: (agentId: string) => string | undefined,
): DelegationProviderInfo[] {
  return agents.map(agent => {
    const reason = unavailableReason(agent)
    const defaultModel = defaultModelFor(agent.id)
    return {
      id: agent.id,
      name: agent.name,
      available: agent.available,
      ...(reason ? { unavailableReason: reason } : {}),
      models: modelsFor(agent.id),
      ...(defaultModel ? { defaultModel } : {}),
    }
  })
}

function availableIds(providers: DelegationProviderInfo[]): string {
  const usable = providers.filter(p => p.available).map(p => p.id)
  return usable.length > 0 ? usable.join(', ') : '(none configured)'
}

/**
 * Resolve a spawn's requested provider/model, falling back to the parent's.
 * Runs *before* a session is created — an unvalidated id produces a thread that
 * dies at bridge start, leaving a dead row in the drawer with a cryptic error.
 */
export function resolveProviderSelection(
  requested: { agentId?: string; model?: string },
  parent: ProviderSelection,
  providers: DelegationProviderInfo[],
): ProviderSelection | SelectionError {
  const agentId = requested.agentId?.trim() || parent.agentId
  const provider = providers.find(p => p.id === agentId)

  if (!provider) {
    return {
      status: 400,
      error: `unknown provider "${agentId}"; available: ${availableIds(providers)}`,
    }
  }
  if (!provider.available) {
    return {
      status: 400,
      error: `provider "${agentId}" is not available (${provider.unavailableReason ?? 'not available'}); available: ${availableIds(providers)}`,
    }
  }

  const requestedModel = requested.model?.trim()
  if (!requestedModel) {
    // Reuse the parent's model only when the provider is the same one — a model id
    // is provider-specific, so carrying it across providers would guarantee a
    // failure at bridge start.
    const inherited = agentId === parent.agentId ? parent.model : ''
    return { agentId, model: inherited || provider.defaultModel || '' }
  }

  // An empty `models` list means the provider only discovers models at start
  // (or reports none), so there is nothing to validate against — pass it through
  // rather than rejecting a model that would actually have worked.
  if (provider.models.length > 0 && !provider.models.includes(requestedModel)) {
    const sample = provider.models.slice(0, CONTEXT_MODELS_PER_PROVIDER).join(', ')
    const more = provider.models.length > CONTEXT_MODELS_PER_PROVIDER
      ? ` (+${provider.models.length - CONTEXT_MODELS_PER_PROVIDER} more, see GET /v1/providers)`
      : ''
    return {
      status: 400,
      error: `unknown model "${requestedModel}" for provider "${agentId}"; known: ${sample}${more}`,
    }
  }

  return { agentId, model: requestedModel }
}
