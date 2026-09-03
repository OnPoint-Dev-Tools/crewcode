import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, flush, renderHook } from './hook-test-host'
import { useCrewcodePromptFiles } from './useCrewcodePromptFiles'

function windowStub(body: () => string): Record<string, unknown> {
  return {
    setInterval,
    clearInterval,
    electronAPI: {
      crewcodeConfigDir: vi.fn(async () => ({ ok: true, path: '/config' })),
      fsReadDir: vi.fn(async (_root: string, sub: string) => ({
        nodes: sub === 'prompts'
          ? [{ name: 'review.md', rel: 'prompts/review.md', kind: 'file' }]
          : [],
      })),
      fsReadFile: vi.fn(async () => ({ ok: true, text: body() })),
    },
  }
}

describe('useCrewcodePromptFiles polling', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('preserves the library object when a poll finds no content change', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', windowStub(() => '# Review\nCheck this change.'))
    const hook = renderHook(useCrewcodePromptFiles, undefined)
    await flush()
    const first = hook.result.current

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await flush()

    expect(hook.result.current).toBe(first)
    hook.unmount()
  })

  it('publishes a new library when file content changes', async () => {
    vi.useFakeTimers()
    let body = '# Review\nFirst version.'
    vi.stubGlobal('window', windowStub(() => body))
    const hook = renderHook(useCrewcodePromptFiles, undefined)
    await flush()
    const first = hook.result.current

    body = '# Review\nSecond version.'
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await flush()

    expect(hook.result.current).not.toBe(first)
    expect(hook.result.current.prompts[0]?.body).toContain('Second version.')
    hook.unmount()
  })
})
