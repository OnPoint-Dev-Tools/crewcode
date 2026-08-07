import { describe, expect, it } from 'vitest'
import { frameLanguageServerMessage, MAX_LANGUAGE_SERVER_MESSAGE_BYTES, parseLanguageServerFrames, type LanguageServerFrameState } from './language-server-framing'

function state(): LanguageServerFrameState {
  return { buffer: Buffer.alloc(0), expectedBytes: null }
}

describe('language server framing', () => {
  it('parses frames split across chunks and preserves UTF-8 byte lengths', () => {
    const parser = state()
    const first = frameLanguageServerMessage(JSON.stringify({ value: '✓' }))
    const second = frameLanguageServerMessage(JSON.stringify({ value: 2 }))
    const bytes = Buffer.from(first + second)

    expect(parseLanguageServerFrames(parser, bytes.subarray(0, 12))).toEqual([])
    expect(parseLanguageServerFrames(parser, bytes.subarray(12, 31))).toEqual([])
    expect(parseLanguageServerFrames(parser, bytes.subarray(31))).toEqual([
      JSON.stringify({ value: '✓' }),
      JSON.stringify({ value: 2 }),
    ])
  })

  it('rejects missing and oversized content lengths', () => {
    expect(() => parseLanguageServerFrames(state(), Buffer.from('Other: 1\r\n\r\n{}'))).toThrow('without Content-Length')
    expect(() => parseLanguageServerFrames(state(), Buffer.from(`Content-Length: ${MAX_LANGUAGE_SERVER_MESSAGE_BYTES + 1}\r\n\r\n`))).toThrow('exceeds')
  })
})
