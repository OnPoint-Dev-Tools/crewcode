import { describe, expect, it, vi } from 'vitest'

import { TerminalOutputBuffer } from './terminal-output-buffer'

function harness(options: { active?: boolean; frameBudget?: number; pendingLimit?: number } = {}) {
  const frames = new Map<number, FrameRequestCallback>()
  const writes: Array<{ data: string; done: () => void }> = []
  let nextFrame = 1
  const queue = new TerminalOutputBuffer(
    (data, done) => writes.push({ data, done }),
    {
      ...options,
      scheduleFrame: callback => {
        const id = nextFrame++
        frames.set(id, callback)
        return id
      },
      cancelFrame: id => { frames.delete(id) },
    },
  )
  const runFrame = () => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined
    if (!entry) return false
    frames.delete(entry[0])
    entry[1](0)
    return true
  }
  return { queue, frames, writes, runFrame }
}

describe('TerminalOutputBuffer', () => {
  it('coalesces output and waits for xterm backpressure before scheduling more', () => {
    const h = harness({ frameBudget: 5 })
    h.queue.enqueue('abc')
    h.queue.enqueue('defgh')
    expect(h.frames.size).toBe(1)

    h.runFrame()
    expect(h.writes.map(write => write.data)).toEqual(['abcde'])
    expect(h.frames.size).toBe(0)

    h.writes[0]!.done()
    expect(h.frames.size).toBe(1)
    h.runFrame()
    expect(h.writes.map(write => write.data)).toEqual(['abcde', 'fgh'])
  })

  it('does no xterm work while inactive and drains after activation', () => {
    const h = harness({ active: false })
    h.queue.enqueue('background output')
    expect(h.frames.size).toBe(0)
    expect(h.writes).toHaveLength(0)

    h.queue.setActive(true)
    expect(h.frames.size).toBe(1)
    h.runFrame()
    expect(h.writes[0]?.data).toBe('background output')
  })

  it('bounds hidden output and reports omitted characters', () => {
    const h = harness({ active: false, frameBudget: 8, pendingLimit: 8 })
    h.queue.enqueue('123456')
    h.queue.enqueue('7890')
    h.queue.setActive(true)
    h.runFrame()

    expect(h.writes[0]?.data).toContain('2 characters of hidden terminal output omitted')
    h.writes[0]!.done()
    h.runFrame()
    expect(h.writes.slice(1).map(write => write.data).join('')).toBe('34567890')
  })

  it('cancels scheduled work on dispose', () => {
    const h = harness()
    h.queue.enqueue('pending')
    const cancel = vi.spyOn(h.frames, 'delete')
    h.queue.dispose()
    expect(cancel).toHaveBeenCalled()
    expect(h.frames.size).toBe(0)
  })
})
