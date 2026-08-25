import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const counters = vi.hoisted(() => ({ workLogRenders: 0 }))

vi.mock('./TurnWorkLog', () => ({
  TurnWorkLog: () => {
    counters.workLogRenders += 1
    return createElement('div', { className: 'mock-work-log' })
  },
}))

vi.mock('react-spinners-kit', () => ({
  SwishSpinner: () => null,
}))

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
    state: { username: 'you', profileIconKind: 'initial', profileIconValue: '', hideVerboseAgentLogs: false },
  }),
}))

import { Messages } from './Messages'
import type { Message, ToolCallMessage } from '../../types'

describe('Messages render isolation', () => {
  it('rerenders a consolidated final-response work log when its tool source changes', () => {
    counters.workLogRenders = 0
    const tool: ToolCallMessage = {
      kind: 'toolcall',
      time: '7:03 PM',
      turnId: 'turn-final',
      toolCallId: 'tool-final',
      toolName: 'bash',
      args: { command: 'npm test' },
      status: 'running',
    }
    const response: Message = {
      kind: 'agent',
      time: '7:03 PM',
      turnId: 'turn-final',
      blocks: [],
      text: 'Done',
      chunks: ['Done'],
      streaming: false,
    }

    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages: [tool, response] }))
    })
    const initialRenders = counters.workLogRenders

    TestRenderer.act(() => {
      renderer.update(createElement(Messages, {
        messages: [{ ...tool, status: 'completed', result: 'passed' }, response],
      }))
    })

    expect(counters.workLogRenders).toBeGreaterThan(initialRenders)
    TestRenderer.act(() => renderer.unmount())
  })

  it('does not rerender a work log when only same-turn thinking changes', () => {
    counters.workLogRenders = 0
    const tool: ToolCallMessage = {
      kind: 'toolcall',
      time: '7:03 PM',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'renderer.ts' },
      status: 'running',
    }
    const firstThinking: Message = {
      kind: 'thinking',
      time: '7:03 PM',
      turnId: 'turn-1',
      segmentId: 'thinking-1',
      text: 'checking',
      chunks: ['checking'],
      streaming: true,
    }

    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages: [tool, firstThinking] }))
    })
    const initialRenders = counters.workLogRenders

    const updatedThinking: Message = {
      ...firstThinking,
      text: 'checking the implementation',
      chunks: ['checking the implementation'],
    }
    TestRenderer.act(() => {
      renderer.update(createElement(Messages, { messages: [tool, updatedThinking] }))
    })

    expect(counters.workLogRenders).toBe(initialRenders)

    TestRenderer.act(() => {
      renderer.update(createElement(Messages, {
        messages: [{ ...tool, status: 'completed', result: 'ok' }, updatedThinking],
      }))
    })
    expect(counters.workLogRenders).toBeGreaterThan(initialRenders)

    TestRenderer.act(() => renderer.unmount())
  })
})
