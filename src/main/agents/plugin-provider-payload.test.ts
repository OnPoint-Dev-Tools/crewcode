import { describe, expect, it } from 'vitest'
import { parseProviderPayload } from './plugin-provider-payload'

const frame = (payload: string, responsePath?: string) =>
  parseProviderPayload(payload, { responsePath, fallbackToRaw: false })
const body = (payload: string, responsePath?: string) =>
  parseProviderPayload(payload, { responsePath, fallbackToRaw: true })

describe('parseProviderPayload stream frames', () => {
  it('reads OpenAI streaming delta content', () => {
    expect(frame('{"choices":[{"delta":{"content":"hello"}}]}')).toBe('hello')
  })

  it('emits nothing for the role-only opening delta', () => {
    expect(frame('{"choices":[{"delta":{"role":"assistant"},"index":0}]}')).toBeNull()
  })

  it('emits nothing for the empty final delta', () => {
    expect(frame('{"choices":[{"delta":{},"finish_reason":"stop"}]}')).toBeNull()
  })

  it('emits nothing for a trailing usage-only chunk', () => {
    expect(frame('{"usage":{"prompt_tokens":12,"completion_tokens":34},"choices":[]}')).toBeNull()
  })

  it('emits nothing for a websocket done frame', () => {
    expect(frame('{"done":true}')).toBeNull()
  })

  it('never echoes unrecognized JSON into the transcript', () => {
    expect(frame('{"unexpected":{"shape":1}}')).toBeNull()
  })

  it('passes plain-text frames through unchanged', () => {
    expect(frame('just text')).toBe('just text')
  })

  it('treats an empty content delta as nothing to emit', () => {
    expect(frame('{"choices":[{"delta":{"content":""}}]}')).toBeNull()
  })
})

describe('parseProviderPayload response bodies', () => {
  it('reads OpenAI non-streaming message content', () => {
    expect(body('{"choices":[{"message":{"role":"assistant","content":"done"}}]}')).toBe('done')
  })

  it('falls back to the raw body when no field matches', () => {
    expect(body('{"unexpected":{"shape":1}}')).toBe('{"unexpected":{"shape":1}}')
  })

  it('returns null for an empty body', () => {
    expect(body('   ')).toBeNull()
  })
})

describe('parseProviderPayload responsePath', () => {
  it('honors a dotted path with array indexes', () => {
    expect(frame('{"choices":[{"delta":{"content":"x"}}]}', 'choices.0.delta.content')).toBe('x')
  })

  it('falls through to the default chain when the path misses', () => {
    expect(frame('{"choices":[{"delta":{"content":"y"}}]}', 'choices.0.message.content')).toBe('y')
  })

  it('ignores a non-string value at the configured path', () => {
    expect(frame('{"choices":[{"delta":{"content":{"nested":1}}}]}')).toBeNull()
  })
})
