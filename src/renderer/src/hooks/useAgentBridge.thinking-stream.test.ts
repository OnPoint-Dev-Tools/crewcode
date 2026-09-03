import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationsProvider } from './useNotifications'
import { useAgentBridge } from './useAgentBridge'
import type { Message } from '../types'
import { createTurnActivity } from '../components/thread/turn-activity'

// Repro harness for "claude thinking streams render as agent messages / vanish":
// drives the exact event sequence observed in the jank trace (thinking bursts →
// tool call → more thinking → final text → turn_end) through the real hook and
// asserts what lands in the message map.

describe('useAgentBridge thinking stream routing', () => {
  let onEvent: ((raw: unknown) => void) | null = null
  const messagesByTab: Record<string, Message[]> = {}
  let messageWrites = 0

  const setMessagesForTab = (tabId: string, updater: (prev: Message[]) => Message[]) => {
    messageWrites += 1
    messagesByTab[tabId] = updater(messagesByTab[tabId] ?? [])
  }

  beforeEach(() => {
    vi.useFakeTimers()
    onEvent = null
    messageWrites = 0
    for (const k of Object.keys(messagesByTab)) delete messagesByTab[k]
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn((cb: (raw: unknown) => void) => {
          onEvent = cb
          return vi.fn()
        }),
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function renderBridge() {
    let renderer!: TestRenderer.ReactTestRenderer
    function Probe(): null {
      useAgentBridge({
        setMessagesForTab,
        bridgeToTab: { b1: 'tab1' },
        bridgeToCwd: { b1: '/repo' },
        bridgeToMode: {},
      })
      return null
    }
    act(() => {
      renderer = TestRenderer.create(
        createElement(NotificationsProvider, null, createElement(Probe)),
      )
    })
    return { unmount: () => act(() => renderer.unmount()) }
  }

  function emit(ev: Record<string, unknown>) {
    act(() => { onEvent?.(ev) })
  }

  function flushBuffers() {
    act(() => { vi.advanceTimersByTime(60) })
  }

  it('keeps thinking deltas as thinking rows across tools and final text', () => {
    const bridge = renderBridge()
    expect(onEvent).not.toBeNull()

    emit({ type: 'turn_start', bridgeId: 'b1', turnId: 't1' })
    emit({ type: 'thinking_delta', bridgeId: 'b1', turnId: 't1', delta: 'I should check ' })
    emit({ type: 'thinking_delta', bridgeId: 'b1', turnId: 't1', delta: 'the config first.' })
    flushBuffers()
    emit({ type: 'tool_start', bridgeId: 'b1', turnId: 't1', toolCallId: 'c1', toolName: 'Read', args: {} })
    emit({ type: 'tool_end', bridgeId: 'b1', turnId: 't1', toolCallId: 'c1', result: 'ok', isError: false })
    emit({ type: 'thinking_delta', bridgeId: 'b1', turnId: 't1', delta: 'Config looks fine.' })
    flushBuffers()
    emit({ type: 'text_delta', bridgeId: 'b1', turnId: 't1', delta: 'Here is the answer.' })
    flushBuffers()
    emit({ type: 'turn_end', bridgeId: 'b1', turnId: 't1' })

    const kinds = (messagesByTab.tab1 ?? []).map(m => m.kind)
    expect(kinds).toEqual(['thinking', 'toolcall', 'thinking', 'agent'])

    const thinking = (messagesByTab.tab1 ?? []).filter(m => m.kind === 'thinking')
    expect(thinking.map(m => (m as Extract<Message, { kind: 'thinking' }>).text)).toEqual([
      'I should check the config first.',
      'Config looks fine.',
    ])
    // Settled — nothing should still be flagged streaming.
    for (const m of messagesByTab.tab1 ?? []) {
      if (m.kind === 'thinking' || m.kind === 'agent') expect(m.streaming).toBe(false)
    }

    bridge.unmount()
  })

  it('drives CrewCode-owned activity from observed bridge events', () => {
    messagesByTab.tab1 = [createTurnActivity('Fix the overlay', 'now')]
    const bridge = renderBridge()

    emit({ type: 'turn_start', bridgeId: 'b1', turnId: 't1' })
    expect(messagesByTab.tab1[0]).toEqual(expect.objectContaining({ status: 'in_progress', turnId: 't1' }))

    emit({ type: 'tool_start', bridgeId: 'b1', turnId: 't1', toolCallId: 'c1', toolName: 'Read', args: {} })
    expect(messagesByTab.tab1[0]).toEqual(expect.objectContaining({ activeForm: 'Reading workspace' }))

    emit({ type: 'turn_end', bridgeId: 'b1', turnId: 't1' })
    expect(messagesByTab.tab1[0]).toEqual(expect.objectContaining({ status: 'completed' }))

    bridge.unmount()
  })

  it('folds raw delta activity into the bounded stream flush', () => {
    messagesByTab.tab1 = [createTurnActivity('Keep the app responsive', 'now')]
    const bridge = renderBridge()

    emit({ type: 'turn_start', bridgeId: 'b1', turnId: 't1' })
    const writesAfterStart = messageWrites
    for (let i = 0; i < 20; i += 1) {
      emit({ type: 'thinking_delta', bridgeId: 'b1', turnId: 't1', delta: String(i) })
    }

    // Raw provider tokens only append to the in-memory delta buffer.
    expect(messageWrites).toBe(writesAfterStart)
    flushBuffers()
    expect(messageWrites).toBe(writesAfterStart + 1)
    expect(messagesByTab.tab1[0]).toEqual(expect.objectContaining({ activeForm: 'Analyzing request' }))

    bridge.unmount()
  })

  it('marks active work interrupted when the bridge errors', () => {
    messagesByTab.tab1 = [createTurnActivity('Fix the overlay', 'now')]
    const bridge = renderBridge()

    emit({ type: 'turn_start', bridgeId: 'b1', turnId: 't1' })
    emit({ type: 'error', bridgeId: 'b1', message: 'provider failed' })

    expect(messagesByTab.tab1[0]).toEqual(expect.objectContaining({ status: 'interrupted' }))
    bridge.unmount()
  })
})
