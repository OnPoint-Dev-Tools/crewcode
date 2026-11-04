import type { AgentUserRequest, AgentUserResponse } from './bridge-types'

export interface CrewCoderQuestion {
  requestId: string
  permission: boolean
  request: Omit<AgentUserRequest, 'requestId' | 'bridgeId'>
  options: Array<{ id: string; value: string }>
  freeText: boolean
}

export function parseCrewCoderQuestion(params: Record<string, unknown>, turnId?: string): CrewCoderQuestion {
  if (params.version !== 1 || typeof params.requestId !== 'string' || !params.requestId
    || typeof params.title !== 'string' || !params.title.trim() || params.title.length > 64_000) {
    throw new Error('Invalid CrewCoder question request')
  }
  const permission = params.kind === 'permission'
  if (params.kind !== 'question' && !permission) throw new Error('Invalid CrewCoder question kind')
  if (params.options !== undefined && (!Array.isArray(params.options) || params.options.length > 100)) {
    throw new Error('Invalid CrewCoder question options')
  }
  const options = (Array.isArray(params.options) ? params.options : []).map((value: unknown, index: number) => {
    if (!value || typeof value !== 'object' || !('label' in value) || !('value' in value)
      || typeof value.label !== 'string' || typeof value.value !== 'string' || !value.value.trim()) {
      throw new Error('Invalid CrewCoder question option')
    }
    return { id: `choice-${index}`, value: value.value, label: value.label,
      description: 'description' in value && typeof value.description === 'string' ? value.description : undefined }
  }).filter(option => !permission || !['acceptForSession', 'session', 'allow_always', 'reject_always'].includes(option.value))
  const freeText = !permission && (params.allowFreeform === true || options.length === 0)
  return {
    requestId: params.requestId, permission, options, freeText,
    request: {
      kind: permission ? 'permission' : freeText ? 'prompt' : 'select',
      turnId, title: params.title, source: 'crewcoder',
      message: typeof params.message === 'string' ? params.message : undefined,
      detail: typeof params.detail === 'string' ? params.detail : undefined,
      placeholder: freeText ? typeof params.placeholder === 'string' ? params.placeholder : 'reply to CrewCoder…' : undefined,
      secret: params.secret === true,
      multiple: !permission && params.multiple === true,
      options: options.length ? options.map(({ id, label, description }) => ({ id, label, description })) : undefined,
    },
  }
}

export function crewCoderQuestionAnswer(question: CrewCoderQuestion, response: AgentUserResponse): Record<string, unknown> {
  if (!['accept', 'submit', 'decline'].includes(response.action)) return { cancelled: true }
  if (!question.permission && response.action === 'decline') return { cancelled: true }
  if (question.request.multiple) {
    if (response.action !== 'submit') return { cancelled: true }
    const ids = response.optionIds ?? []
    if (new Set(ids).size !== ids.length || ids.some(id => !question.options.some(option => option.id === id))) return { cancelled: true }
    const values = question.options.filter(option => ids.includes(option.id)).map(option => option.value)
    if (question.freeText && response.value?.trim()) values.push(response.value.trim())
    return values.length ? { cancelled: false, values } : { cancelled: true }
  }
  const selected = question.options.find(option => option.id === response.optionId)
  if (selected) return { cancelled: false, value: selected.value }
  if (question.permission) {
    const values = response.action === 'decline' ? ['decline', 'reject', 'reject_once'] : ['accept', 'turn', 'allow', 'allow_once']
    const option = question.options.find(option => values.includes(option.value))
    return option ? { cancelled: false, value: option.value } : { cancelled: true }
  }
  if (question.freeText && response.action === 'submit' && response.value?.trim()) {
    return { cancelled: false, value: response.value }
  }
  // A generic Allow/Deny action is not an answer to a provider's arbitrary choices.
  return { cancelled: true }
}
