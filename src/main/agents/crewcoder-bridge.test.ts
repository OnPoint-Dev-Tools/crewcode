import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeEvent } from './bridge-types'

const spawnAgentProcess = vi.hoisted(() => vi.fn())
vi.mock('./agent-spawn', () => ({ spawnAgentProcess }))

import {
  CREWCODER_PROMPT_INACTIVITY_TIMEOUT_MS,
  createCrewCoderBridge,
  crewCoderAcpErrorMessage,
  createCrewCoderToolProjectionState,
  crewCoderEventsFromUpdate,
  InactivityWatchdog,
  crewCoderPermissionOptions,
  crewCoderUsageFromPromptResult,
} from './crewcoder-bridge'

afterEach(() => {
  vi.useRealTimers()
  spawnAgentProcess.mockReset()
})

class FakeAcpProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 123
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

function crewCoderAcpHarness(options: { directoryError?: string } = {}): { proc: FakeAcpProcess; sent: Array<Record<string, unknown>> } {
  const proc = new FakeAcpProcess()
  const sent: Array<Record<string, unknown>> = []
  let input = ''
  proc.stdin.setEncoding('utf8')
  proc.stdin.on('data', (chunk: string) => {
    input += chunk
    let newline: number
    while ((newline = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as Record<string, unknown>
      sent.push(message)
      if (message.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
      } else if (message.method === 'session/new') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-1' } })}\n`)
      } else if (message.method === 'session/set_external_directories') {
        proc.stdout.write(`${JSON.stringify(options.directoryError
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: options.directoryError } }
          : { jsonrpc: '2.0', id: message.id, result: {} })}\n`)
      } else if (message.method === 'session/follow_up') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { queued: true } })}\n`)
      } else if (message.method === 'session/set_reasoning_effort') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
      }
    }
  })
  return { proc, sent }
}

describe('CrewCoder ACP errors', () => {
  it('prefers actionable RequestError data over the generic JSON-RPC message', () => {
    expect(crewCoderAcpErrorMessage({
      code: -32603,
      message: 'Internal error',
      data: { message: 'Your input exceeds the context window of this model.' },
    })).toBe('Your input exceeds the context window of this model.')
  })

  it('falls back to the JSON-RPC message when no detailed message exists', () => {
    expect(crewCoderAcpErrorMessage({ code: -32603, message: 'Internal error' })).toBe('Internal error')
  })
})

describe('CrewCoder external directories', () => {
  it('synchronizes session grants after ACP session creation', async () => {
    const harness = crewCoderAcpHarness()
    spawnAgentProcess.mockResolvedValue({ proc: harness.proc, dir: '/repo', remote: false })

    await createCrewCoderBridge('crewcoder', {
      bridgeId: 'bridge',
      provider: 'crewcoder',
      cwd: '/repo',
      mode: 'build',
      externalDirectories: ['/shared/one', '/shared/two'],
    }, () => {})

    expect(harness.sent).toContainEqual(expect.objectContaining({
      method: 'session/set_external_directories',
      params: {
        sessionId: 'session-1',
        directories: ['/shared/one', '/shared/two'],
      },
    }))
  })

  it('fails closed when native-session grant synchronization fails', async () => {
    const harness = crewCoderAcpHarness({ directoryError: 'directory missing' })
    spawnAgentProcess.mockResolvedValue({ proc: harness.proc, dir: '/repo', remote: false })
    const events: BridgeEvent[] = []
    const bridge = await createCrewCoderBridge('crewcoder', {
      bridgeId: 'bridge',
      provider: 'crewcoder',
      cwd: '/repo',
      mode: 'build',
      externalDirectories: ['/missing'],
    }, event => events.push(event))

    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'session/set_external_directories: directory missing' }))
    expect(await bridge.prompt('must not run')).toEqual({
      ok: false,
      error: 'crewcoder acp: bridge must restart because external directory synchronization failed',
    })
  })
})

describe('CrewCoder reasoning effort', () => {
  it('sets the selected effort on the ACP session', async () => {
    const harness = crewCoderAcpHarness()
    spawnAgentProcess.mockResolvedValue({ proc: harness.proc, dir: '/repo', remote: false })
    await createCrewCoderBridge('crewcoder', {
      bridgeId: 'bridge', provider: 'crewcoder', cwd: '/repo', mode: 'build', thinking: 'high',
    }, () => {})

    expect(harness.sent).toContainEqual(expect.objectContaining({
      method: 'session/set_reasoning_effort',
      params: { sessionId: 'session-1', effort: 'high' },
    }))
  })
})

describe('CrewCoder follow-ups', () => {
  it('queues a follow-up through the active ACP session', async () => {
    const harness = crewCoderAcpHarness()
    spawnAgentProcess.mockResolvedValue({ proc: harness.proc, dir: '/repo', remote: false })
    const bridge = await createCrewCoderBridge('crewcoder', {
      bridgeId: 'bridge',
      provider: 'crewcoder',
      cwd: '/repo',
      mode: 'build',
    }, () => {})

    await bridge.prompt('initial task')
    expect(await bridge.prompt('also add tests', { streamingBehavior: 'followUp' })).toEqual({ ok: true })
    expect(harness.sent).toContainEqual(expect.objectContaining({
      method: 'session/follow_up',
      params: { sessionId: 'session-1', message: 'also add tests' },
    }))
  })
})

describe('CrewCoder ACP prompt inactivity watchdog', () => {
  it('resets its deadline whenever ACP activity arrives', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = new InactivityWatchdog(1_000, onTimeout)

    vi.advanceTimersByTime(900)
    watchdog.activity()
    vi.advanceTimersByTime(900)
    expect(onTimeout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('does not count time spent waiting for permission', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = new InactivityWatchdog(1_000, onTimeout)

    vi.advanceTimersByTime(900)
    watchdog.pause()
    vi.advanceTimersByTime(10_000)
    expect(onTimeout).not.toHaveBeenCalled()

    watchdog.resume()
    vi.advanceTimersByTime(999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('stays stopped after explicit cleanup', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = new InactivityWatchdog(1_000, onTimeout)

    watchdog.stop()
    watchdog.activity()
    watchdog.resume()
    vi.advanceTimersByTime(2_000)

    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('cancels CrewCoder before ending a genuinely inactive turn', async () => {
    vi.useFakeTimers()
    const harness = crewCoderAcpHarness()
    spawnAgentProcess.mockResolvedValue({ proc: harness.proc, dir: '/repo', remote: false })
    const events: BridgeEvent[] = []
    const bridge = await createCrewCoderBridge('crewcoder', {
      bridgeId: 'bridge',
      provider: 'crewcoder',
      cwd: '/repo',
      mode: 'build',
    }, event => events.push(event))

    await bridge.prompt('work')
    await vi.advanceTimersByTimeAsync(CREWCODER_PROMPT_INACTIVITY_TIMEOUT_MS)

    expect(harness.sent.at(-1)).toMatchObject({
      method: 'session/cancel',
      params: { sessionId: 'session-1' },
    })
    expect(events.some(event => event.type === 'turn_end')).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.proc.killed).toBe(true)
    expect(await bridge.prompt('do not overlap')).toEqual({
      ok: false,
      error: 'crewcoder acp: bridge must restart after an unresponsive cancellation',
    })
    expect(events).toContainEqual({
      type: 'error',
      bridgeId: 'bridge',
      message: 'crewcoder acp: session/prompt timed out',
    })
    expect(events.some(event => event.type === 'turn_end')).toBe(true)
  })
})

describe('CrewCoder ACP update projection', () => {
  it('preserves genuine short reasoning that ends in an ellipsis', () => {
    const events = crewCoderEventsFromUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking types...' },
    }, 'bridge', 'turn', createCrewCoderToolProjectionState())

    expect(events).toEqual([{
      type: 'thinking_delta',
      bridgeId: 'bridge',
      turnId: 'turn',
      delta: 'Checking types...',
    }])
  })

  it('announces a permission-pending tool only once', () => {
    const state = createCrewCoderToolProjectionState()
    const pending = crewCoderEventsFromUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'edit src/App.tsx',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: 'src/App.tsx' },
    }, 'bridge', 'turn', state)
    const running = crewCoderEventsFromUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'edit src/App.tsx',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { path: 'src/App.tsx' },
    }, 'bridge', 'turn', state)

    expect(pending).toEqual([expect.objectContaining({
      type: 'tool_start',
      toolCallId: 'tc-1',
      toolName: 'edit',
      args: { path: 'src/App.tsx' },
    })])
    expect(running).toEqual([expect.objectContaining({
      type: 'tool_update',
      toolCallId: 'tc-1',
      args: { path: 'src/App.tsx' },
      title: 'edit src/App.tsx',
    })])
  })

  it('projects streamed tool content and retains start arguments on completion', () => {
    const state = createCrewCoderToolProjectionState()
    crewCoderEventsFromUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'bash npm test',
      kind: 'execute',
      rawInput: { command: 'npm test' },
    }, 'bridge', 'turn', state)

    const progress = crewCoderEventsFromUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-2',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'running' } }],
    }, 'bridge', 'turn', state)
    const completed = crewCoderEventsFromUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-2',
      status: 'completed',
      rawOutput: { output: 'passed' },
    }, 'bridge', 'turn', state)

    expect(progress).toEqual([expect.objectContaining({
      type: 'tool_update',
      partial: 'running',
      args: { command: 'npm test' },
    })])
    expect(completed).toEqual([expect.objectContaining({
      type: 'tool_end',
      result: { output: 'passed' },
      isError: false,
      args: { command: 'npm test' },
      title: 'bash npm test',
    })])
  })

  it('projects CrewCoder compaction lifecycle updates', () => {
    expect(crewCoderEventsFromUpdate({
      sessionUpdate: '_crewcoder/compaction_update',
      status: 'started',
      automatic: true,
      phase: 'summarizing',
      percent: 35,
      message: 'Summarizing older context…',
    }, 'bridge', 'turn', createCrewCoderToolProjectionState())).toEqual([{
      type: 'compaction_event',
      bridgeId: 'bridge',
      turnId: 'turn',
      status: 'started',
      automatic: true,
      message: 'Summarizing older context…',
      percent: 35,
      provider: 'crewcoder',
    }])

    expect(crewCoderEventsFromUpdate({
      sessionUpdate: '_crewcoder/compaction_update',
      status: 'completed',
      automatic: true,
      percent: 100,
      message: 'Context compacted.',
    }, 'bridge', 'turn', createCrewCoderToolProjectionState())).toEqual([{
      type: 'compaction_event',
      bridgeId: 'bridge',
      turnId: 'turn',
      status: 'completed',
      automatic: true,
      message: 'Context compacted.',
      percent: 100,
      provider: 'crewcoder',
      resetContext: true,
    }])
  })

  it('ignores malformed compaction and unknown session update kinds', () => {
    expect(crewCoderEventsFromUpdate(
      { sessionUpdate: '_crewcoder/compaction_update', status: 'unknown' },
      'bridge',
      'turn',
      createCrewCoderToolProjectionState(),
    )).toEqual([])
    expect(crewCoderEventsFromUpdate(
      { sessionUpdate: 'session_info_update', title: 'ignored' },
      'bridge',
      'turn',
      createCrewCoderToolProjectionState(),
    )).toEqual([])
  })
})

describe('CrewCoder ACP permissions', () => {
  it('exposes only once-only choices so live mode changes stay authoritative', () => {
    expect(crewCoderPermissionOptions({
      options: [
        { optionId: 'allow_once', name: 'Allow' },
        { optionId: 'allow_always', name: 'Always allow' },
        { optionId: 'reject_once', name: 'Reject' },
        { optionId: 'reject_always', name: 'Always reject' },
      ],
    })).toEqual([
      { id: 'allow_once', label: 'Allow', description: undefined },
      { id: 'reject_once', label: 'Reject', description: undefined },
    ])
  })
})

describe('CrewCoder ACP usage', () => {
  it('prefers namespaced usage and maps live context occupancy', () => {
    expect(crewCoderUsageFromPromptResult({
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      _meta: {
        'crewcoder/usage': {
          inputTokens: 1234,
          outputTokens: 567,
          totalTokens: 1801,
          lastInputTokens: 1200,
          contextWindow: 200_000,
        },
      },
    }, 'codex:gpt-5.6-sol')).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      totalTokens: 1801,
      contextTokens: 1200,
      contextWindow: 200_000,
      model: 'codex:gpt-5.6-sol',
    })
  })

  it('falls back to top-level hermes-compatible usage', () => {
    expect(crewCoderUsageFromPromptResult({
      usage: { inputTokens: 40, outputTokens: 2, totalTokens: 42 },
    }, 'custom:model')).toEqual({
      inputTokens: 40,
      outputTokens: 2,
      totalTokens: 42,
      contextTokens: 42,
      contextWindow: undefined,
      model: 'custom:model',
    })
  })
})
