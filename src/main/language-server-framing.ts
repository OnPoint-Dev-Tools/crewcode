export const MAX_LANGUAGE_SERVER_MESSAGE_BYTES = 8 * 1024 * 1024

export interface LanguageServerFrameState {
  buffer: Buffer
  expectedBytes: number | null
}

export function parseLanguageServerFrames(state: LanguageServerFrameState, chunk: Buffer): string[] {
  state.buffer = Buffer.concat([state.buffer, chunk])
  const messages: string[] = []
  while (true) {
    if (state.expectedBytes == null) {
      const headerEnd = state.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) break
      const header = state.buffer.subarray(0, headerEnd).toString('ascii')
      state.buffer = state.buffer.subarray(headerEnd + 4)
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
      if (!match) throw new Error('language server sent a frame without Content-Length')
      const size = Number(match[1])
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LANGUAGE_SERVER_MESSAGE_BYTES) {
        throw new Error(`language server frame exceeds ${MAX_LANGUAGE_SERVER_MESSAGE_BYTES} bytes`)
      }
      state.expectedBytes = size
    }
    if (state.buffer.length < state.expectedBytes) break
    messages.push(state.buffer.subarray(0, state.expectedBytes).toString('utf8'))
    state.buffer = state.buffer.subarray(state.expectedBytes)
    state.expectedBytes = null
  }
  return messages
}

export function frameLanguageServerMessage(message: string): string {
  return `Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`
}
