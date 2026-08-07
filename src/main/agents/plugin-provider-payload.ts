// Plugin provider payload extraction.
//
// A payload is either a whole single-shot response body or one stream frame
// (SSE event / websocket message). That distinction matters: a single-shot body
// IS the answer, so unrecognized JSON can reasonably be shown raw. A stream frame
// that carries no text (OpenAI's role-only opening delta, the empty final delta
// with finish_reason, a trailing usage-only chunk, {"done":true}) must emit
// nothing -- echoing it spliced raw JSON into the visible transcript.

export interface ProviderPayloadOptions {
  responsePath?: string
  /** True only for whole response bodies, never for stream frames. */
  fallbackToRaw: boolean
}

function valueAtPath(json: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current == null) return undefined
    const index = Number(part)
    if (Array.isArray(current) && Number.isInteger(index)) return current[index]
    if (typeof current === 'object') return (current as Record<string, unknown>)[part]
    return undefined
  }, json)
}

function textCandidates(json: unknown): unknown[] {
  const record = json as Record<string, any> | null
  return [
    record?.text,
    record?.response,
    record?.message,
    record?.output,
    record?.choices?.[0]?.message?.content,
    record?.choices?.[0]?.delta?.content,
  ]
}

/**
 * Returns the reply text in a provider payload, or null when the payload carries
 * no text to emit. Callers must skip null rather than emitting an empty delta.
 */
export function parseProviderPayload(payload: string, options: ProviderPayloadOptions): string | null {
  if (!payload.trim()) return null

  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    // Not JSON at all: providers streaming plain text are legitimate.
    return payload
  }

  if (typeof json === 'string') return json || null

  if (options.responsePath) {
    const configured = valueAtPath(json, options.responsePath)
    if (typeof configured === 'string') return configured || null
  }

  const found = textCandidates(json).find(value => typeof value === 'string')
  if (typeof found === 'string') return found || null

  return options.fallbackToRaw ? payload : null
}
