import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBridge, BridgeEvent } from './bridge-types'

const spawnAgentProcess = vi.hoisted(() => vi.fn())
vi.mock('./agent-spawn', () => ({ spawnAgentProcess }))

import { createGrokBridge } from './grok-bridge'
import {
  createGrokToolProjectionState,
  grokContextWindow,
  grokEventsFromUpdate,
  grokPermissionMode,
  grokPermissionOptions,
  grokReasoningEffort,
  grokRequestErrorMessage,
  grokStderrMessage,
  grokSelectedOption,
  grokSpawnArgs,
  grokToolBlocked,
  grokToolMeta,
  grokUpdateStartsTurn,
  grokUsageFromPromptResult,
  type GrokSessionUpdate,
} from './grok-bridge'

// Captured verbatim from `grok agent stdio` 0.2.118 so the fixtures cannot
// drift into a shape the real provider never sends.
const REAL_PERMISSION_PARAMS = {
  sessionId: '019fcfa3-663d-7583-a7c5-1cd1a0525f8b',
  toolCall: {
    toolCallId: 'call-60d1a3c0-0',
    kind: 'edit',
    title: 'Write `/tmp/grokprobe/probe-out.txt`',
    rawInput: { variant: 'Write', file_path: '/tmp/grokprobe/probe-out.txt', content: 'BANANA\n' },
    _meta: {
      'x.ai/tool': { version: 1, name: 'write', kind: 'write', namespace: 'opencode', label: 'Write', read_only: false },
    },
  },
  options: [
    { optionId: 'allow-edits-session', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
  ],
}

const REAL_PROMPT_RESULT = {
  stopReason: 'end_turn',
  _meta: {
    sessionId: '019fcfa3-9b4d-72e1-941a-d274afe13e77',
    totalTokens: 12298,
    modelId: 'grok-4.5',
    inputTokens: 12266,
    outputTokens: 32,
    cachedReadTokens: 128,
    reasoningTokens: 20,
    usage: {
      inputTokens: 24440,
      outputTokens: 100,
      totalTokens: 24540,
      modelCalls: 2,
    },
  },
}

const REAL_INITIALIZE_META = {
  currentWorkingDirectory: '/tmp/grokprobe',
  modelState: {
    currentModelId: 'grok-4.5',
    availableModels: [
      { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { totalContextTokens: 500000, supportsReasoningEffort: true } },
    ],
  },
}

describe('grokPermissionMode', () => {
  it('never inherits the user global grok config for a read-only role', () => {
    // toolPolicy outranks the composer mode: a supervisor stays read-only even
    // when the chat it was spawned from is in Full Access.
    expect(grokPermissionMode({ mode: 'full', toolPolicy: 'read-only' })).toBe('dontAsk')
  })

  it('maps ask and plan to the strictest mode', () => {
    // dontAsk was measured to still prompt for a client-side write rather than
    // auto-denying, so this is the floor, not the enforcement. The bridge's own
    // permission and fs/write refusals are what actually hold the line.
    expect(grokPermissionMode({ mode: 'ask' })).toBe('dontAsk')
    expect(grokPermissionMode({ mode: 'plan' })).toBe('dontAsk')
  })

  it('maps build to interactive approval and full to bypass', () => {
    expect(grokPermissionMode({ mode: 'build' })).toBe('default')
    // Full Access routes through 'default' (not native bypass) so the tripwire can inspect commands.
    expect(grokPermissionMode({ mode: 'full' })).toBe('default')
  })

  it('defaults an absent mode to interactive approval rather than bypass', () => {
    expect(grokPermissionMode({})).toBe('default')
  })
})

describe('grokSpawnArgs', () => {
  it('puts --permission-mode before the agent subcommand', () => {
    // `grok agent stdio` accepts none of these flags; only top-level grok does.
    const args = grokSpawnArgs({ mode: 'build' })
    expect(args.indexOf('--permission-mode')).toBeLessThan(args.indexOf('agent'))
    expect(args.slice(-2)).toEqual(['agent', 'stdio'])
  })

  it('always emits a permission mode so config can never decide it', () => {
    for (const mode of ['ask', 'plan', 'build', 'full'] as const) {
      expect(grokSpawnArgs({ mode })).toContain('--permission-mode')
    }
  })

  it('passes model and clamped effort', () => {
    const args = grokSpawnArgs({ mode: 'build', model: 'grok-4.5', thinking: 'max' })
    expect(args).toEqual(['--permission-mode', 'default', '--model', 'grok-4.5', '--effort', 'high', 'agent', 'stdio'])
  })

  it('omits effort when unset so grok keeps its own default', () => {
    expect(grokSpawnArgs({ mode: 'build' })).not.toContain('--effort')
  })
})

describe('grokReasoningEffort', () => {
  it('clamps the wider CrewCode enum into grok low/medium/high', () => {
    // Grok rejects an unknown effort for the whole process, so an unclamped
    // xhigh/ultra would kill the bridge at spawn instead of one turn.
    expect(grokReasoningEffort('xhigh')).toBe('high')
    expect(grokReasoningEffort('ultra')).toBe('high')
    expect(grokReasoningEffort('medium')).toBe('medium')
    expect(grokReasoningEffort('off')).toBe('low')
    expect(grokReasoningEffort(undefined)).toBeUndefined()
  })
})

describe('grokPermissionOptions', () => {
  it('drops the session-scoped allow_always choice', () => {
    // allow-edits-session outlives the turn and would survive a later mode change.
    const options = grokPermissionOptions(REAL_PERMISSION_PARAMS)
    expect(options.map(option => option.id)).toEqual(['allow-once', 'reject-once'])
    expect(JSON.stringify(options)).not.toContain('allow-edits-session')
  })

  it('filters by kind rather than by vendor id spelling', () => {
    const options = grokPermissionOptions({
      options: [
        { optionId: 'grant-forever', name: 'Always', kind: 'allow_always' },
        { optionId: 'weird-id', name: 'Just once', kind: 'allow_once' },
      ],
    })
    expect(options.map(option => option.id)).toEqual(['weird-id'])
  })

  it('falls back to once-only choices when the agent sends none', () => {
    expect(grokPermissionOptions({}).map(option => option.id)).toEqual(['allow-once', 'reject-once'])
  })
})

describe('grokSelectedOption', () => {
  it('resolves an accept to the real allow_once id', () => {
    const options = grokPermissionOptions(REAL_PERMISSION_PARAMS)
    expect(grokSelectedOption({ requestId: 'r', action: 'accept' }, REAL_PERMISSION_PARAMS, options)).toBe('allow-once')
  })

  it('returns null for cancel and decline so the bridge sends cancelled', () => {
    const options = grokPermissionOptions(REAL_PERMISSION_PARAMS)
    expect(grokSelectedOption({ requestId: 'r', action: 'cancel' }, REAL_PERMISSION_PARAMS, options)).toBeNull()
    expect(grokSelectedOption({ requestId: 'r', action: 'decline' }, REAL_PERMISSION_PARAMS, options)).toBeNull()
  })

  it('never resolves to a filtered-out session-scoped option', () => {
    const options = grokPermissionOptions(REAL_PERMISSION_PARAMS)
    const selected = grokSelectedOption(
      { requestId: 'r', action: 'accept', optionId: 'allow-edits-session' },
      REAL_PERMISSION_PARAMS,
      options,
    )
    expect(selected).toBe('allow-once')
  })
})

describe('grokToolMeta', () => {
  it('prefers the vendor tool name over the coarse ACP kind', () => {
    const update = { sessionUpdate: 'tool_call', kind: 'edit', title: 'Write `/x`', _meta: { 'x.ai/tool': { name: 'write', read_only: false } } } as unknown as GrokSessionUpdate
    expect(grokToolMeta(update)).toEqual({ name: 'write', readOnly: false })
  })

  it('falls back to title then kind when the vendor block is absent', () => {
    expect(grokToolMeta({ sessionUpdate: 'tool_call', title: 'grep' } as GrokSessionUpdate).name).toBe('grep')
    expect(grokToolMeta({ sessionUpdate: 'tool_call', kind: 'read' } as GrokSessionUpdate).name).toBe('read')
  })
})

describe('grokToolBlocked', () => {
  const readOnly = { mode: 'ask' } as const

  it('blocks a mutating tool in a read-only mode', () => {
    expect(grokToolBlocked(readOnly, { name: 'write', readOnly: false })).toBe(true)
    expect(grokToolBlocked({ toolPolicy: 'read-only' }, { name: 'bash' })).toBe(true)
  })

  it('allows a tool grok marks read_only', () => {
    expect(grokToolBlocked(readOnly, { name: 'read_file', readOnly: true })).toBe(false)
  })

  it('fails closed on an unknown mutating name with no read_only flag', () => {
    expect(grokToolBlocked(readOnly, { name: 'run_terminal_cmd' })).toBe(true)
    expect(grokToolBlocked(readOnly, { name: 'apply_patch' })).toBe(true)
  })

  it('does not gate build or full modes', () => {
    expect(grokToolBlocked({ mode: 'build' }, { name: 'write', readOnly: false })).toBe(false)
    expect(grokToolBlocked({ mode: 'full' }, { name: 'bash' })).toBe(false)
  })
})

describe('grokUsageFromPromptResult', () => {
  it('reads per-turn tokens from _meta, not the cumulative ledger', () => {
    // _meta.usage is summed across the turn's model calls; using it as context
    // occupancy double-counts a two-call turn (24440 vs the real 12266).
    const usage = grokUsageFromPromptResult(REAL_PROMPT_RESULT, 'grok-4.5', 500000)
    expect(usage?.inputTokens).toBe(12266)
    expect(usage?.outputTokens).toBe(32)
    expect(usage?.contextTokens).toBe(12298)
    expect(usage?.contextWindow).toBe(500000)
  })

  it('reports the cumulative total when present', () => {
    expect(grokUsageFromPromptResult(REAL_PROMPT_RESULT, 'grok-4.5')?.totalTokens).toBe(24540)
  })

  it('returns undefined for a result with no usage meta', () => {
    expect(grokUsageFromPromptResult({ stopReason: 'end_turn' })).toBeUndefined()
    expect(grokUsageFromPromptResult(null)).toBeUndefined()
  })
})

describe('grokContextWindow', () => {
  it('reads the active model context size from initialize meta', () => {
    expect(grokContextWindow(REAL_INITIALIZE_META, 'grok-4.5')).toBe(500000)
  })

  it('falls back to the current model when the requested id is absent', () => {
    expect(grokContextWindow(REAL_INITIALIZE_META, 'not-a-model')).toBe(500000)
  })

  it('returns undefined rather than guessing when meta is missing', () => {
    expect(grokContextWindow({}, 'grok-4.5')).toBeUndefined()
    expect(grokContextWindow(undefined)).toBeUndefined()
  })
})

describe('grokEventsFromUpdate', () => {
  const bridgeId = 'b1'
  const turnId = 't1'

  it('projects message and thought chunks onto the shared stream', () => {
    const tools = createGrokToolProjectionState()
    expect(grokEventsFromUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, bridgeId, turnId, tools))
      .toEqual([{ type: 'text_delta', bridgeId, turnId, delta: 'hi' }])
    expect(grokEventsFromUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }, bridgeId, turnId, tools))
      .toEqual([{ type: 'thinking_delta', bridgeId, turnId, delta: 'hm' }])
  })

  it('announces a tool once and settles it on completion', () => {
    const tools = createGrokToolProjectionState()
    const start = grokEventsFromUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'write', rawInput: { file_path: '/x' }, _meta: { 'x.ai/tool': { name: 'write' } } },
      bridgeId, turnId, tools,
    )
    expect(start).toEqual([{ type: 'tool_start', bridgeId, turnId, toolCallId: 'c1', toolName: 'write', args: { file_path: '/x' } }])

    const done = grokEventsFromUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { ok: true } },
      bridgeId, turnId, tools,
    )
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ type: 'tool_end', toolCallId: 'c1', isError: false })
    expect(tools.settled.has('c1')).toBe(true)
  })

  it('synthesizes a start when a completion arrives for an unseen call', () => {
    // Fail closed on a malformed stream: the renderer drops an orphan tool_end.
    const tools = createGrokToolProjectionState()
    const events = grokEventsFromUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed', title: 'read' },
      bridgeId, turnId, tools,
    )
    expect(events.map(event => event.type)).toEqual(['tool_start', 'tool_end'])
  })

  it('marks a failed tool as an error', () => {
    const tools = createGrokToolProjectionState()
    grokEventsFromUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'bash' }, bridgeId, turnId, tools)
    const [end] = grokEventsFromUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'failed' },
      bridgeId, turnId, tools,
    )
    expect(end).toMatchObject({ type: 'tool_end', isError: true })
  })

  it('ignores user echo and unknown vendor update kinds', () => {
    const tools = createGrokToolProjectionState()
    expect(grokEventsFromUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } }, bridgeId, turnId, tools)).toEqual([])
    expect(grokEventsFromUpdate({ sessionUpdate: 'available_commands_update' }, bridgeId, turnId, tools)).toEqual([])
    expect(grokEventsFromUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }, bridgeId, turnId, tools)).toEqual([])
  })

  it('drops a tool update with no call id instead of emitting a dangling row', () => {
    const tools = createGrokToolProjectionState()
    expect(grokEventsFromUpdate({ sessionUpdate: 'tool_call', title: 'write' }, bridgeId, turnId, tools)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Live bridge: the refusal paths that keep a mode from being advisory only
// ---------------------------------------------------------------------------

afterEach(() => {
  spawnAgentProcess.mockReset()
})

class FakeAcpProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

interface Harness {
  proc: FakeAcpProcess
  sent: Array<Record<string, unknown>>
  /** Replies to a client->agent request by id, mirroring grok's own numbering from 0. */
  serverRequest: (id: number, method: string, params: Record<string, unknown>) => void
  notify: (method: string, params: Record<string, unknown>) => void
  replyTo: (method: string) => Record<string, unknown> | undefined
}

function grokHarness(): Harness {
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
        proc.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: 1, _meta: REAL_INITIALIZE_META },
        })}\n`)
      } else if (message.method === 'session/new') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'grok-session-1' } })}\n`)
      } else if (message.method === 'session/set_model') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
      }
    }
  })
  return {
    proc,
    sent,
    serverRequest: (id, method, params) => {
      proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    },
    notify: (method, params) => {
      proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    replyTo: (method) => {
      const request = sent.find(message => message.method === method)
      if (!request) return undefined
      return sent.find(message => message.id === request.id && message.method === undefined)
    },
  }
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

async function startBridge(mode: 'ask' | 'plan' | 'build' | 'full', extra: Record<string, unknown> = {}): Promise<{
  harness: Harness & { bridge: AgentBridge }
  events: BridgeEvent[]
  responses: () => Array<Record<string, unknown>>
}> {
  const harness = grokHarness()
  spawnAgentProcess.mockResolvedValue({ proc: harness.proc, dir: '/repo', remote: false })
  const events: BridgeEvent[] = []
  const bridge = await createGrokBridge('grok', {
    bridgeId: 'b-grok',
    provider: 'grok',
    cwd: '/repo',
    mode,
    ...extra,
  } as never, event => events.push(event), async () => ({ requestId: 'r', action: 'accept' }))
  await settle()
  return {
    harness: Object.assign(harness, { bridge }),
    events,
    responses: () => harness.sent.filter(message => message.method === undefined && message.id !== undefined),
  }
}

describe('grok bridge spawn', () => {
  it('passes CrewCode\'s permission mode to the process', async () => {
    const harness = grokHarness()
    spawnAgentProcess.mockResolvedValue({ proc: harness.proc, dir: '/repo', remote: false })
    await createGrokBridge('grok', {
      bridgeId: 'b', provider: 'grok', cwd: '/repo', mode: 'ask',
    } as never, () => {}, async () => ({ requestId: 'r', action: 'accept' }))
    const args = spawnAgentProcess.mock.calls[0][0].args as string[]
    expect(args).toEqual(['--permission-mode', 'dontAsk', 'agent', 'stdio'])
  })

  it('never sends _meta.yoloMode on session/new', async () => {
    // _meta only escalates. Permission policy belongs to the spawn flag.
    const { harness } = await startBridge('full')
    const sessionNew = harness.sent.find(message => message.method === 'session/new')
    expect(JSON.stringify(sessionNew)).not.toContain('yoloMode')
  })
})

describe('grok bridge permission refusal', () => {
  it('cancels a permission request in ask mode instead of approving', async () => {
    const { harness, responses } = await startBridge('ask')
    harness.serverRequest(0, 'session/request_permission', REAL_PERMISSION_PARAMS)
    await settle()
    const reply = responses().find(message => message.id === 0)
    expect(reply?.result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('cancels for a read-only role even in full access', async () => {
    const { harness, responses } = await startBridge('full', { toolPolicy: 'read-only' })
    harness.serverRequest(0, 'session/request_permission', REAL_PERMISSION_PARAMS)
    await settle()
    expect(responses().find(message => message.id === 0)?.result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('auto-approves with the once-only option in full access', async () => {
    const { harness, responses } = await startBridge('full')
    harness.serverRequest(0, 'session/request_permission', REAL_PERMISSION_PARAMS)
    await settle()
    const reply = responses().find(message => message.id === 0)
    // Never allow-edits-session: a session-scoped grant outlives the turn.
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('handles a server request numbered 0', async () => {
    // Grok numbers its requests from 0; a truthiness check would drop this one
    // and hang the turn waiting for a reply that never comes.
    const { harness, responses } = await startBridge('full')
    harness.serverRequest(0, 'session/request_permission', REAL_PERMISSION_PARAMS)
    await settle()
    expect(responses().some(message => message.id === 0)).toBe(true)
  })
})

describe('grok bridge filesystem refusal', () => {
  it('refuses fs/write_text_file in plan mode', async () => {
    // Grok delegates writes to the client, so this call is the last gate before
    // bytes hit disk — measured: dontAsk alone does not stop it.
    const { harness, responses } = await startBridge('plan')
    harness.serverRequest(0, 'fs/write_text_file', { path: '/repo/x.txt', content: 'nope' })
    await settle()
    const reply = responses().find(message => message.id === 0)
    expect(reply?.error).toMatchObject({ message: expect.stringContaining('write blocked') })
    expect(reply?.result).toBeUndefined()
  })

  it('refuses fs/write_text_file for a read-only role in build mode', async () => {
    const { harness, responses } = await startBridge('build', { toolPolicy: 'read-only' })
    harness.serverRequest(0, 'fs/write_text_file', { path: '/repo/x.txt', content: 'nope' })
    await settle()
    expect(responses().find(message => message.id === 0)?.error).toBeDefined()
  })

  it('declines terminal capability cleanly rather than crashing the agent', async () => {
    const { harness, responses } = await startBridge('build')
    harness.serverRequest(0, 'terminal/create', {})
    await settle()
    expect(responses().find(message => message.id === 0)?.error).toMatchObject({ code: -32601 })
  })
})

describe('grok bridge vendor notification channel', () => {
  it('reads turn usage from _x.ai/session_notification', async () => {
    // Usage appears ONLY on this channel while streaming; a standard-only ACP
    // client renders a dead context meter.
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('go')
    harness.notify('session/update', {
      sessionId: 'grok-session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    })
    await settle()
    harness.notify('_x.ai/session_notification', {
      sessionId: 'grok-session-1',
      update: { sessionUpdate: 'response_completed', usage: { input_tokens: 12046, output_tokens: 68 } },
    })
    await settle()
    const usage = events.find(event => event.type === 'usage_update')
    expect(usage).toBeDefined()
    expect(usage && 'usage' in usage ? usage.usage.inputTokens : undefined).toBe(12046)
    expect(usage && 'usage' in usage ? usage.usage.contextWindow : undefined).toBe(500000)
  })

  it('ignores vendor chrome notifications', async () => {
    const { harness, events } = await startBridge('build')
    harness.notify('_x.ai/announcements/update', { gen: 1 })
    harness.notify('_x.ai/queue/changed', { sessionId: 'grok-session-1', entries: [] })
    await settle()
    expect(events.some(event => event.type === 'error')).toBe(false)
  })
})

describe('grok bridge read-only tool gate', () => {
  it('blocks a mutating tool announcement in ask mode', async () => {
    const { harness, events } = await startBridge('ask')
    await harness.bridge.prompt('go')
    harness.notify('session/update', {
      sessionId: 'grok-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'write',
        _meta: { 'x.ai/tool': { name: 'write', read_only: false } },
      },
    })
    await settle()
    expect(events.some(event => event.type === 'tool_start')).toBe(false)
    expect(events.some(event => event.type === 'error')).toBe(true)
  })

  it('allows a read-only tool in ask mode', async () => {
    const { harness, events } = await startBridge('ask')
    await harness.bridge.prompt('go')
    harness.notify('session/update', {
      sessionId: 'grok-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c2',
        title: 'read_file',
        _meta: { 'x.ai/tool': { name: 'read_file', read_only: true } },
      },
    })
    await settle()
    expect(events.some(event => event.type === 'tool_start')).toBe(true)
  })
})

describe('grok bridge failure reporting', () => {
  // Captured verbatim from `grok agent stdio` 1.0.0 against an exhausted free
  // quota. Grok answers session/prompt with a JSON-RPC error whose `message`
  // is useless and whose `data` holds the entire actionable explanation.
  const REAL_RATE_LIMIT_ERROR = {
    code: -32003,
    message: 'Rate limited',
    data: 'API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You\'ve used all the included free usage for model grok-4.5 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 513300/500000. Upgrade to a Grok subscription for higher limits: https://grok.com/supergrok',
  }

  it('reports the quota detail, not just "Rate limited"', () => {
    const message = grokRequestErrorMessage('session/prompt', REAL_RATE_LIMIT_ERROR)
    expect(message).toContain('free-usage-exhausted')
    expect(message).toContain('513300/500000')
    expect(message).toContain('https://grok.com/supergrok')
  })

  it('does not repeat the summary when data already restates it', () => {
    expect(grokRequestErrorMessage('session/prompt', { message: 'Rate limited', data: 'Rate limited: slow down' }))
      .toBe('session/prompt: Rate limited: slow down')
    expect(grokRequestErrorMessage('session/new', { message: 'boom' })).toBe('session/new: boom')
  })

  it('surfaces the prompt failure as an error event', async () => {
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('hi')
    const promptRequest = harness.sent.find(message => message.method === 'session/prompt')
    harness.proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptRequest?.id, error: REAL_RATE_LIMIT_ERROR })}\n`)
    await settle(); await settle()

    const error = events.find(event => event.type === 'error')
    expect(error && 'message' in error ? error.message : '').toContain('free-usage-exhausted')
    // The turn must still end, or the composer stays stuck on "working".
    expect(events.filter(event => event.type === 'turn_end')).toHaveLength(1)
    expect(await harness.bridge.prompt('again')).toEqual({ ok: true })
  })

  it('strips tracing noise and ANSI from stderr', () => {
    const raw = '[2m2026-08-07T20:52:30.333496Z[0m [31mERROR[0m responses API error [3mstatus[0m[2m=[0m429 Too Many Requests'
    const message = grokStderrMessage(raw)
    expect(message).toBe('responses API error status=429 Too Many Requests')
    expect(message).not.toContain('')
    expect(grokStderrMessage('  Shell cwd was reset to /repo  ')).toBeNull()
    expect(grokStderrMessage('   ')).toBeNull()
  })

  it('collapses the identical error grok logs once per retry attempt', async () => {
    const { harness, events } = await startBridge('build')
    const line = '[31mERROR[0m Rate limited: free-usage-exhausted\n'
    harness.proc.stderr.write(line)
    harness.proc.stderr.write(line)
    harness.proc.stderr.write(line)
    await settle()
    expect(events.filter(event => event.type === 'error')).toHaveLength(1)
  })
})

describe('grok bridge out-of-turn updates', () => {
  it('does not open a turn for session chrome', () => {
    expect(grokUpdateStartsTurn('available_commands_update')).toBe(false)
    expect(grokUpdateStartsTurn('current_mode_update')).toBe(false)
    expect(grokUpdateStartsTurn('session_info_update')).toBe(false)
    expect(grokUpdateStartsTurn('user_message_chunk')).toBe(false)
    expect(grokUpdateStartsTurn('agent_message_chunk')).toBe(true)
    expect(grokUpdateStartsTurn('tool_call')).toBe(true)
  })

  it('accepts the first prompt after grok pushes pre-turn chrome', async () => {
    // Grok emits available_commands_update twice right after session/new,
    // before any prompt exists. Starting a turn there pinned the composer as
    // running and made the first real prompt fail with "a turn is already
    // running" — the bug this test exists to prevent.
    const { harness, events } = await startBridge('build')
    harness.notify('session/update', {
      sessionId: 'grok-session-1',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] },
    })
    harness.notify('session/update', {
      sessionId: 'grok-session-1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    })
    await settle()
    expect(events.some(event => event.type === 'turn_start')).toBe(false)

    const bridge = harness.bridge
    const result = await bridge.prompt('hello')
    expect(result).toEqual({ ok: true })
  })

  it('ignores turn content flushed after the prompt already returned', async () => {
    // Grok keeps pushing updates after it answers session/prompt. Those used
    // to open a second turn that nothing could ever end: the composer stayed
    // "working" after the reply was done, and the user's next message failed
    // with "a turn is already running".
    const { harness, events } = await startBridge('build')
    expect(await harness.bridge.prompt('first')).toEqual({ ok: true })

    const promptRequest = harness.sent.find(message => message.method === 'session/prompt')
    harness.proc.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: promptRequest?.id,
      result: REAL_PROMPT_RESULT,
    })}\n`)
    await settle(); await settle()
    expect(events.filter(event => event.type === 'turn_end')).toHaveLength(1)

    harness.notify('session/update', {
      sessionId: 'grok-session-1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-late-0', status: 'completed' },
    })
    harness.notify('session/update', {
      sessionId: 'grok-session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'trailing' } },
    })
    await settle()

    expect(events.filter(event => event.type === 'turn_start')).toHaveLength(1)
    expect(await harness.bridge.prompt('second')).toEqual({ ok: true })
  })

  it('still rejects a genuinely concurrent prompt', async () => {
    const { harness } = await startBridge('build')
    const bridge = harness.bridge
    expect(await bridge.prompt('first')).toEqual({ ok: true })
    const second = await bridge.prompt('second')
    expect(second.ok).toBe(false)
    expect(second.error).toContain('already running')
  })
})

describe('grok bridge follow-up queue', () => {
  /** Settle the in-flight session/prompt so the turn ends and the queue drains. */
  function settlePrompt(harness: Harness & { bridge: AgentBridge }, index = 0): void {
    const prompts = harness.sent.filter(message => message.method === 'session/prompt')
    const target = prompts[index]
    if (!target) throw new Error(`no session/prompt at index ${index}`)
    harness.proc.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: target.id,
      result: REAL_PROMPT_RESULT,
    })}\n`)
  }

  it('queues a follow-up instead of rejecting it mid-turn', async () => {
    const { harness, events } = await startBridge('build')
    expect(await harness.bridge.prompt('first')).toEqual({ ok: true })
    const queued = await harness.bridge.prompt('second', { streamingBehavior: 'followUp' })
    expect(queued).toEqual({ ok: true })

    const event = events.find(item => item.type === 'follow_up_queued')
    expect(event).toBeDefined()
    expect(event && 'text' in event ? event.text : '').toBe('second')
    // Only one session/prompt is ever in flight.
    expect(harness.sent.filter(message => message.method === 'session/prompt')).toHaveLength(1)
  })

  it('sends the queued follow-up once the turn ends', async () => {
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('first')
    await harness.bridge.prompt('second', { streamingBehavior: 'followUp' })

    settlePrompt(harness)
    await settle()
    await settle()

    const prompts = harness.sent.filter(message => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect((prompts[1].params as { prompt: Array<{ text: string }> }).prompt[0].text).toBe('second')
    expect(events.some(item => item.type === 'follow_up_removed' && item.reason === 'sent')).toBe(true)
  })

  it('drains in FIFO order', async () => {
    const { harness } = await startBridge('build')
    await harness.bridge.prompt('first')
    await harness.bridge.prompt('a', { streamingBehavior: 'followUp' })
    await harness.bridge.prompt('b', { streamingBehavior: 'followUp' })

    settlePrompt(harness)
    await settle(); await settle()
    settlePrompt(harness, 1)
    await settle(); await settle()

    const texts = harness.sent
      .filter(message => message.method === 'session/prompt')
      .map(message => (message.params as { prompt: Array<{ text: string }> }).prompt[0].text)
    expect(texts).toEqual(['first', 'a', 'b'])
  })

  it('still rejects a concurrent prompt that is not a follow-up', async () => {
    const { harness } = await startBridge('build')
    await harness.bridge.prompt('first')
    const second = await harness.bridge.prompt('second')
    expect(second.ok).toBe(false)
    expect(second.error).toContain('already running')
  })

  it('cancels a queued follow-up before it is sent', async () => {
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('first')
    await harness.bridge.prompt('second', { streamingBehavior: 'followUp' })
    const queuedId = events.flatMap(item => item.type === 'follow_up_queued' ? [item.followUpId] : [])[0]

    expect(await harness.bridge.removeFollowUp?.(queuedId)).toEqual({ ok: true })
    expect(events.some(item => item.type === 'follow_up_removed' && item.reason === 'removed')).toBe(true)

    settlePrompt(harness)
    await settle(); await settle()
    expect(harness.sent.filter(message => message.method === 'session/prompt')).toHaveLength(1)
  })

  it('reports a follow-up that can no longer be cancelled', async () => {
    const { harness } = await startBridge('build')
    await harness.bridge.prompt('first')
    const result = await harness.bridge.removeFollowUp?.('nope')
    expect(result?.ok).toBe(false)
  })

  it('clears the queue when the turn is aborted', async () => {
    // A queued message must not fire at a turn the user just cancelled.
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('first')
    await harness.bridge.prompt('second', { streamingBehavior: 'followUp' })
    await harness.bridge.abort()
    expect(events.some(item => item.type === 'follow_up_removed' && item.reason === 'cleared')).toBe(true)

    settlePrompt(harness)
    await settle(); await settle()
    expect(harness.sent.filter(message => message.method === 'session/prompt')).toHaveLength(1)
  })

  it('clears the queue on stop', async () => {
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('first')
    await harness.bridge.prompt('second', { streamingBehavior: 'followUp' })
    await harness.bridge.stop()
    expect(events.some(item => item.type === 'follow_up_removed' && item.reason === 'cleared')).toBe(true)
  })
})

describe('grok bridge follow-up pill lifecycle', () => {
  it('retracts the pill with the same id it was queued under', async () => {
    // The renderer keys pills by followUpId, so a mismatch between the queued
    // and removed id leaves the pill on screen forever.
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('first')
    await harness.bridge.prompt('second', { streamingBehavior: 'followUp' })

    const prompts = harness.sent.filter(message => message.method === 'session/prompt')
    harness.proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: prompts[0].id, result: REAL_PROMPT_RESULT })}\n`)
    await settle()
    await settle()

    const queuedIds = events.flatMap(item => item.type === 'follow_up_queued' ? [item.followUpId] : [])
    const removedIds = events.flatMap(item => item.type === 'follow_up_removed' ? [item.followUpId] : [])
    expect(queuedIds).toHaveLength(1)
    expect(removedIds).toEqual(queuedIds)
  })

  it('retracts every pill exactly once', async () => {
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('first')
    await harness.bridge.prompt('a', { streamingBehavior: 'followUp' })
    await harness.bridge.prompt('b', { streamingBehavior: 'followUp' })

    const prompts = () => harness.sent.filter(message => message.method === 'session/prompt')
    harness.proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: prompts()[0].id, result: REAL_PROMPT_RESULT })}\n`)
    await settle(); await settle()
    harness.proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: prompts()[1].id, result: REAL_PROMPT_RESULT })}\n`)
    await settle(); await settle()

    const removed = events.flatMap(item => item.type === 'follow_up_removed' ? [item.followUpId] : [])
    expect(removed).toHaveLength(2)
    expect(new Set(removed).size).toBe(2)
  })

  it('retracts queued pills when the process dies', async () => {
    // Nothing can send them now; a stranded pill would never clear.
    const { harness, events } = await startBridge('build')
    await harness.bridge.prompt('first')
    await harness.bridge.prompt('second', { streamingBehavior: 'followUp' })

    harness.proc.emit('close', 1)
    await settle()

    expect(events.some(item => item.type === 'follow_up_removed' && item.reason === 'cleared')).toBe(true)
  })
})
