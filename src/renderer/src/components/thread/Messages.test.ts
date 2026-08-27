import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-spinners-kit', () => ({
  SwishSpinner: () => null,
}))

const settings = vi.hoisted(() => ({
  hideVerboseAgentLogs: false,
  voiceProvider: 'off' as 'off' | 'local',
  voiceLocalVoice: 'am_michael',
  voiceLocalPythonPath: '',
  voiceLocalDevice: 'auto',
  voiceLocalSpeed: 1,
  voiceOpenAIVoice: 'alloy',
  voiceXaiVoice: 'rex',
}))

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
    state: { username: 'you', profileIconKind: 'initial', profileIconValue: '', ...settings },
  }),
}))

import { Messages } from './Messages'
import type { Message } from '../../types'

function transcript(): Message[] {
  return [
    {
      kind: 'thinking',
      time: '7:03 PM',
      turnId: 'turn-1',
      segmentId: 'turn-1-thinking-1',
      text: 'first reasoning block',
      chunks: ['first reasoning block'],
      streaming: false,
    },
    {
      kind: 'toolcall',
      time: '7:03 PM',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'renderer.ts' },
      status: 'completed',
      result: 'ok',
    },
    {
      kind: 'thinking',
      time: '7:03 PM',
      turnId: 'turn-1',
      segmentId: 'turn-1-thinking-2',
      text: 'second reasoning block',
      chunks: ['second reasoning block'],
      streaming: false,
    },
    {
      kind: 'toolcall',
      time: '7:03 PM',
      turnId: 'turn-1',
      toolCallId: 'tool-2',
      toolName: 'bash',
      args: { command: 'npm test' },
      status: 'completed',
      result: 'ok',
    },
    {
      kind: 'agent',
      time: '7:03 PM',
      turnId: 'turn-1',
      blocks: [],
      text: 'final answer',
      chunks: ['final answer'],
      streaming: false,
    },
  ]
}

type JsonNode = TestRenderer.ReactTestRendererJSON | TestRenderer.ReactTestRendererJSON[] | null

function renderOrder(node: JsonNode, out: string[] = []): string[] {
  if (!node) return out
  if (Array.isArray(node)) {
    for (const child of node) renderOrder(child, out)
    return out
  }

  const className = typeof node.props.className === 'string' ? node.props.className.trim() : ''
  if (className === 'thinking' || className === 'thinking streaming') out.push('thinking')
  if (className === 'wl wl-compact') out.push('worklog')
  if (className === 'agent') out.push('agent')

  for (const child of node.children ?? []) {
    if (typeof child === 'object' && child) renderOrder(child as TestRenderer.ReactTestRendererJSON, out)
  }
  return out
}

function collectText(node: JsonNode, out: string[] = []): string[] {
  if (!node) return out
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  for (const child of node.children ?? []) {
    if (typeof child === 'string') out.push(child)
    else if (typeof child === 'object' && child) collectText(child as TestRenderer.ReactTestRendererJSON, out)
  }
  return out
}

function countClass(node: JsonNode, classNameToFind: string): number {
  if (!node) return 0
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countClass(child, classNameToFind), 0)
  const className = typeof node.props.className === 'string' ? node.props.className.trim() : ''
  const self = className === classNameToFind ? 1 : 0
  return self + (node.children ?? []).reduce((sum, child) => (
    typeof child === 'object' && child ? sum + countClass(child as TestRenderer.ReactTestRendererJSON, classNameToFind) : sum
  ), 0)
}

describe('Messages transcript ordering', () => {
  beforeEach(() => {
    settings.hideVerboseAgentLogs = false
    settings.voiceProvider = 'off'
  })

  it('never hides provider reasoning when verbose tool logs are hidden', () => {
    settings.hideVerboseAgentLogs = true
    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages: transcript() }))
    })

    expect(renderOrder(renderer.toJSON())).toEqual(['thinking', 'thinking', 'agent'])
    expect(collectText(renderer.toJSON()).filter(text => text === 'Thinking')).toHaveLength(2)

    TestRenderer.act(() => renderer.unmount())
  })
  it('moves agent copy into the usage strip and reserves the footer action for enabled voice', () => {
    settings.voiceProvider = 'local'
    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages: transcript() }))
    })

    const agent = renderer.root.findByProps({ className: 'agent' })
    const usage = agent.findByProps({ className: 'usage-strip' })
    const footer = agent.findByProps({ className: 'ts' })
    expect(usage.findAll(node => typeof node.props.className === 'string' && node.props.className.trim() === 'msg-copy')).toHaveLength(1)
    expect(footer.findAll(node => typeof node.props.className === 'string' && node.props.className.trim() === 'msg-copy')).toHaveLength(0)
    expect(footer.findAll(node => typeof node.props.className === 'string' && node.props.className.includes('msg-speech'))).toHaveLength(1)

    TestRenderer.act(() => renderer.unmount())
  })

  it('consolidates interleaved tool runs immediately before the final response', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages: transcript() }))
    })

    expect(renderOrder(renderer.toJSON())).toEqual([
      'thinking',
      'thinking',
      'worklog',
      'agent',
    ])
    const text = collectText(renderer.toJSON()).join(' ').replace(/\s+/g, ' ')
    expect(text).toContain('2 tool calls')
    expect(text).toContain('renderer.ts')
    expect(text).toContain('npm test')

    TestRenderer.act(() => {
      renderer.unmount()
    })
  })

  it('shows every changed file with real stats below the consolidated work log', () => {
    const messages: Message[] = [
      {
        kind: 'toolcall',
        time: '7:03 PM',
        turnId: 'turn-files',
        toolCallId: 'tool-files',
        toolName: 'edit',
        args: { path: 'src/alpha.ts' },
        status: 'completed',
        fileChanges: [
          {
            path: 'src/alpha.ts',
            beforeText: 'old',
            afterText: 'new\nnext',
            patch: 'diff --git a/src/alpha.ts b/src/alpha.ts\n--- a/src/alpha.ts\n+++ b/src/alpha.ts\n@@ -1 +1,2 @@\n-old\n+new\n+next',
          },
          {
            path: 'src/beta.css',
            beforeText: '',
            afterText: '.beta {}',
            patch: 'diff --git a/src/beta.css b/src/beta.css\n--- a/src/beta.css\n+++ b/src/beta.css\n@@ -0,0 +1 @@\n+.beta {}',
          },
        ],
      },
      {
        kind: 'agent',
        time: '7:03 PM',
        turnId: 'turn-files',
        blocks: [],
        text: 'Done',
        streaming: false,
      },
    ]
    const onOpenTurnChange = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages, onOpenTurnChange }))
    })

    const strip = renderer.root.findByProps({ 'data-worklog-changed-files': true })
    const text = collectText(renderer.toJSON()).join(' ').replace(/\s+/g, ' ')
    expect(text).toMatch(/alpha\.ts\s+\+\s*2\s+-\s*1/)
    expect(text).toMatch(/beta\.css\s+\+\s*1/)
    expect(strip.findAllByType('button')).toHaveLength(2)

    TestRenderer.act(() => {
      strip.findByProps({ title: 'View turn diff for src/alpha.ts' }).props.onClick()
    })
    expect(onOpenTurnChange).toHaveBeenCalledWith({ turnId: 'turn-files', filePath: 'src/alpha.ts' })

    TestRenderer.act(() => renderer.unmount())
  })

  it('never renders the raw tool-result JSON as a diff for preview-format edits', () => {
    // Regression: an edit tool whose result nests a line-numbered preview under
    // `details.diff` (not a real unified diff) and has no fileChange. The old
    // fallback stringified the whole result and rendered it under a synthetic
    // `diff --git` header. The row must show without leaking the JSON body.
    const messages: Message[] = [
      {
        kind: 'toolcall',
        time: '7:05 PM',
        turnId: 'turn-3',
        toolCallId: 'tool-edit-1',
        toolName: 'edit',
        args: { path: 'src/tui/overlay.ts' },
        status: 'completed',
        result: {
          content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in src/tui/overlay.ts.' }],
          details: { diff: '  29   for (let i = 0; i < panel.length; i++) {\n  30   const row = top + i;', firstChangedLine: 33 },
        },
      },
    ]
    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages }))
    })

    const text = collectText(renderer.toJSON()).join('\n')
    expect(text).not.toContain('"content"')
    expect(text).not.toContain('firstChangedLine')
    expect(text).not.toContain('diff --git')

    TestRenderer.act(() => {
      renderer.unmount()
    })
  })

  it('shows the loading block immediately after a user send starts running', () => {
    const messages: Message[] = [
      { kind: 'user', text: 'build this', time: '7:04 PM' },
    ]
    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages, isRunning: true }))
    })

    expect(countClass(renderer.toJSON(), 'thread-sticky-loader')).toBe(1)

    TestRenderer.act(() => {
      renderer.unmount()
    })
  })

  it('renders the stream cursor only on the latest agent message', () => {
    const messages: Message[] = [
      { kind: 'agent', time: '7:01 PM', turnId: 'turn-1', blocks: [], text: 'old', streaming: true },
      { kind: 'user', text: 'continue', time: '7:02 PM' },
      { kind: 'agent', time: '7:03 PM', turnId: 'turn-2', blocks: [], text: 'latest', streaming: true },
    ]
    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages, isRunning: true }))
    })

    expect(countClass(renderer.toJSON(), 'stream-cursor')).toBe(1)

    TestRenderer.act(() => renderer.unmount())
  })

  it('keeps the loading block visible while final text is still streaming', () => {
    const messages: Message[] = [
      { kind: 'user', text: 'build this', time: '7:04 PM' },
      {
        kind: 'agent',
        time: '7:04 PM',
        turnId: 'turn-2',
        blocks: [],
        text: 'working on it',
        chunks: ['working on it'],
        streaming: true,
      },
    ]
    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(Messages, { messages, isRunning: true }))
    })

    expect(countClass(renderer.toJSON(), 'thread-sticky-loader')).toBe(1)

    const settledMessages: Message[] = [
      { kind: 'user', text: 'build this', time: '7:04 PM' },
      {
        kind: 'agent',
        time: '7:04 PM',
        turnId: 'turn-2',
        blocks: [],
        text: 'working on it',
        chunks: ['working on it'],
        streaming: false,
      },
    ]
    TestRenderer.act(() => {
      renderer.update(createElement(Messages, { messages: settledMessages, isRunning: false }))
    })

    expect(countClass(renderer.toJSON(), 'thread-sticky-loader')).toBe(0)

    TestRenderer.act(() => {
      renderer.unmount()
    })
  })
})
