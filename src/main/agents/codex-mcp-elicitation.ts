import type { RequestUserFn } from './bridge-types'

export async function answerCodexMcpElicitation(
  params: Record<string, unknown>, autoAccept: boolean,
  requestUser?: RequestUserFn, signal?: AbortSignal,
): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: unknown }> {
  const schema = params.requestedSchema as { type?: unknown; properties?: Record<string, unknown>; required?: unknown[] } | undefined
  const consentOnly = ['form', 'openai/form', 'openaiForm'].includes(String(params.mode))
    && schema?.type === 'object' && schema.properties !== undefined
    && Object.keys(schema.properties).length === 0 && (schema.required?.length ?? 0) === 0
  const needsInput = params.mode !== 'url' && !consentOnly
  // Consent may be automatic, but form answers and out-of-band authentication
  // must never be manufactured from the execution mode.
  if (autoAccept && !needsInput && params.mode !== 'url') return { action: 'accept', content: {} }
  if (!requestUser || signal?.aborted) return { action: 'cancel' }
  const response = await requestUser({
    kind: needsInput ? 'prompt' : 'permission',
    title: `MCP request: ${String(params.serverName ?? 'tool')}`,
    message: typeof params.message === 'string' ? params.message : 'Tool access requested',
    detail: JSON.stringify(params.mode === 'url' ? { url: params.url } : params.requestedSchema, null, 2),
    ...(needsInput ? { placeholder: 'Enter the requested form as a JSON object' } : {}),
    turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
    source: 'codex',
  }, signal)
  if (signal?.aborted || response.action === 'cancel') return { action: 'cancel' }
  if (response.action !== 'accept' && response.action !== 'submit') return { action: 'decline' }
  if (!needsInput) return { action: 'accept', ...(params.mode === 'url' ? {} : { content: {} }) }
  try {
    const content: unknown = JSON.parse(response.value ?? '')
    if (content && typeof content === 'object' && !Array.isArray(content)) return { action: 'accept', content }
  } catch { /* Invalid input must never become an empty accepted answer. */ }
  throw new Error('MCP form response must be a JSON object matching the displayed schema')
}
