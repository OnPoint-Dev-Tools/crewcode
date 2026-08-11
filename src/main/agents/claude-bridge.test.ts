import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock, resolveSettingsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  resolveSettingsMock: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  resolveSettings: resolveSettingsMock,
}))

import { allowClaudeToolInput, answerClaudeAskUserQuestionInput, claudeAskUserQuestionRequest, createClaudeBridge, getClaudeCompactionSettings, getClaudeModeOptions } from './claude-bridge'
import type { BridgeStartOpts } from './bridge-types'

function mockClaudeQuery() {
  queryMock.mockImplementation(({ options }) => ({
    options,
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success' }
    },
  }))
}

beforeEach(() => {
  queryMock.mockReset()
  resolveSettingsMock.mockReset()
  resolveSettingsMock.mockResolvedValue({ effective: {}, provenance: {}, sources: [] })
  mockClaudeQuery()
})

describe('claude bridge mode options', () => {
  it('keeps ask mode read-only by disallowing write-capable tools', () => {
    const opts = getClaudeModeOptions('ask')

    expect(opts.permissionMode).toBe('default')
    expect(opts.disallowedTools).toContain('Bash')
    expect(opts.disallowedTools).toContain('Edit')
    expect(opts.disallowedTools).toContain('Write')
  })

  it('keeps plan mode read-only instead of the SDK native plan mode', () => {
    // Native `permissionMode: 'plan'` makes the headless claude binary auto-approve
    // its own ExitPlanMode tool and start coding without surfacing the plan. Plan
    // must stay read-only so the user drives the plan→Build transition.
    const opts = getClaudeModeOptions('plan')

    expect(opts.permissionMode).toBe('default')
    expect(opts.disallowedTools).toContain('Bash')
    expect(opts.disallowedTools).toContain('Edit')
    expect(opts.disallowedTools).toContain('Write')
    // ExitPlanMode is auto-resolved by the SDK without hitting canUseTool, so it
    // must be blocked here or Claude self-approves its plan and starts coding.
    expect(opts.disallowedTools).toContain('ExitPlanMode')
  })

  it('does not block ExitPlanMode in ask mode (only plan does)', () => {
    const opts = getClaudeModeOptions('ask')
    expect(opts.disallowedTools).not.toContain('ExitPlanMode')
  })

  it('routes full sessions through canUseTool (default) so the tripwire can see commands', () => {
    // Full Access no longer uses the SDK-native bypassPermissions; it auto-approves
    // via canUseTool EXCEPT for denylisted catastrophic commands. No mode blindly bypasses.
    expect(getClaudeModeOptions('full')).toEqual({ permissionMode: 'default' })
  })

  it('defaults to normal Claude permission prompts for build sessions', () => {
    expect(getClaudeModeOptions('build')).toEqual({ permissionMode: 'default' })
    expect(getClaudeModeOptions()).toEqual({ permissionMode: 'default' })
  })

  it.each([true, false])('inherits an explicit global Claude auto-compaction value (%s)', async enabled => {
    resolveSettingsMock.mockResolvedValue({ effective: { autoCompactEnabled: enabled }, provenance: {}, sources: [] })

    await expect(getClaudeCompactionSettings('/repo')).resolves.toEqual({ autoCompactEnabled: enabled })
    expect(resolveSettingsMock).toHaveBeenCalledWith({ cwd: '/repo', settingSources: ['user'] })
  })

  it('leaves Claude native defaults untouched when the global setting is absent or unreadable', async () => {
    await expect(getClaudeCompactionSettings('/repo')).resolves.toBeUndefined()
    resolveSettingsMock.mockRejectedValueOnce(new Error('settings unavailable'))
    await expect(getClaudeCompactionSettings('/repo')).resolves.toBeUndefined()
  })

  it('passes only the resolved global auto-compaction scalar to query turns', async () => {
    resolveSettingsMock.mockResolvedValue({ effective: { autoCompactEnabled: true, model: 'ignored-global-model' }, provenance: {}, sources: [] })
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', model: 'claude-test-256k-query' }
    const bridge = await createClaudeBridge('/bin/claude', opts, vi.fn())

    await bridge.prompt('hello')

    expect(queryMock.mock.calls[0][0].options.settings).toEqual({ autoCompactEnabled: true })
  })

  it('omits flag settings when Claude has no explicit global auto-compaction value', async () => {
    const bridge = await createClaudeBridge('/bin/claude', { bridgeId: 'b1', provider: 'claude', cwd: '/repo' }, vi.fn())
    await bridge.prompt('hello')
    expect(queryMock.mock.calls[0][0].options.settings).toBeUndefined()
  })

  it('loads project guidance while disabling passive SDK skills', async () => {
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build' }
    const bridge = await createClaudeBridge('/bin/claude', opts, vi.fn())

    await bridge.prompt('hello')

    expect(queryMock.mock.calls[0][0].options.settingSources).toEqual(['project'])
    expect(queryMock.mock.calls[0][0].options.skills).toEqual([])
  })

  it('rejects the Codex-only ultra effort', async () => {
    await expect(createClaudeBridge('/bin/claude', {
      bridgeId: 'ultra', provider: 'claude', cwd: '/repo', thinking: 'ultra',
    }, vi.fn())).rejects.toThrow('does not support reasoning effort "ultra"')
  })

  it('maps off to disabled thinking and named levels to native effort', async () => {
    const offBridge = await createClaudeBridge('/bin/claude', {
      bridgeId: 'off', provider: 'claude', cwd: '/repo', thinking: 'off',
    }, vi.fn())
    await offBridge.prompt('hello')
    expect(queryMock.mock.calls[0][0].options.thinking).toEqual({ type: 'disabled' })
    expect(queryMock.mock.calls[0][0].options.effort).toBeUndefined()

    const maxBridge = await createClaudeBridge('/bin/claude', {
      bridgeId: 'max', provider: 'claude', cwd: '/repo', thinking: 'max',
    }, vi.fn())
    await maxBridge.prompt('hello')
    expect(queryMock.mock.calls[1][0].options.effort).toBe('max')
    expect(queryMock.mock.calls[1][0].options.thinking).toBeUndefined()
  })

  it('echoes tool input when allowing Claude permission requests', () => {
    const input = { command: 'git status' }

    expect(allowClaudeToolInput(input)).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('extracts AskUserQuestion choices for the bridge overlay', () => {
    const request = claudeAskUserQuestionRequest({
      questions: [{
        question: 'Which approach should we use?',
        header: 'Approach',
        options: [
          { label: 'Fast', description: 'Ship quickly' },
          { label: 'Safe', description: 'Add guardrails', preview: 'Extra checks' },
        ],
        multiSelect: false,
      }],
    })

    expect(request).toMatchObject({
      title: 'Which approach should we use?',
      message: 'Claude asks: Approach',
      options: [
        { id: 'Fast', label: 'Fast', description: 'Ship quickly' },
        { id: 'Safe', label: 'Safe', description: 'Add guardrails', preview: 'Extra checks' },
      ],
    })
  })

  it('extracts freeform AskUserQuestion prompts for the bridge overlay', () => {
    const request = claudeAskUserQuestionRequest({
      questions: [{
        question: 'What should the branch be called?',
        header: 'Branch name',
        custom: true,
      }],
    })

    expect(request).toMatchObject({
      kind: 'prompt',
      title: 'What should the branch be called?',
      message: 'Claude asks: Branch name',
      placeholder: 'reply to Claude…',
    })
  })

  it('writes the selected AskUserQuestion answer back into Claude tool input', () => {
    const input = {
      questions: [{
        question: 'Which approach should we use?',
        header: 'Approach',
        options: [
          { label: 'Fast', description: 'Ship quickly' },
          { label: 'Safe', description: 'Add guardrails', preview: 'Extra checks' },
        ],
        multiSelect: false,
      }],
    }

    expect(answerClaudeAskUserQuestionInput(input, {
      requestId: 'r1',
      action: 'submit',
      optionId: 'Safe',
    })).toEqual({
      ...input,
      answers: { 'Which approach should we use?': 'Safe' },
      annotations: { 'Which approach should we use?': { preview: 'Extra checks' } },
    })
  })

  it('extracts and answers every question in a multi-question Claude request', () => {
    const input = {
      questions: [
        { question: 'Which approach?', options: [{ label: 'Safe' }] },
        { question: 'What branch name?', custom: true },
      ],
    }

    expect(claudeAskUserQuestionRequest(input, 1)).toMatchObject({
      kind: 'prompt',
      title: 'What branch name?',
      message: 'Question 2 of 2.',
    })

    const firstAnswer = answerClaudeAskUserQuestionInput(input, {
      requestId: 'r1', action: 'submit', optionId: 'Safe',
    }, 0)
    expect(answerClaudeAskUserQuestionInput(firstAnswer, {
      requestId: 'r2', action: 'submit', value: 'feature/questions',
    }, 1)).toMatchObject({
      answers: {
        'Which approach?': 'Safe',
        'What branch name?': 'feature/questions',
      },
    })
  })

  it('writes freeform AskUserQuestion answers back into Claude tool input', () => {
    const input = {
      questions: [{
        question: 'What should the branch be called?',
        header: 'Branch name',
        custom: true,
      }],
    }

    expect(answerClaudeAskUserQuestionInput(input, {
      requestId: 'r1',
      action: 'submit',
      value: 'feature/opencode-questions',
    })).toEqual({
      ...input,
      answers: { 'What should the branch be called?': 'feature/opencode-questions' },
    })
  })

  it('keeps accepting the original single-question Claude input shape', () => {
    const input = {
      question: 'Which approach?',
      header: 'Approach',
      options: [{ label: 'Safe' }, { label: 'Fast' }],
      multiSelect: false,
    }

    expect(claudeAskUserQuestionRequest(input)).toMatchObject({
      kind: 'select',
      title: 'Which approach?',
      options: [{ id: 'Safe', label: 'Safe' }, { id: 'Fast', label: 'Fast' }],
    })
    expect(answerClaudeAskUserQuestionInput(input, {
      requestId: 'r1', action: 'submit', optionId: 'Safe',
    })).toEqual({
      ...input,
      answers: { 'Which approach?': 'Safe' },
    })
  })

  it('answers every Claude question through canUseTool without a permission fallthrough', async () => {
    const requestUser = vi.fn()
      .mockResolvedValueOnce({ requestId: 'r1', action: 'submit', optionId: 'Safe' })
      .mockResolvedValueOnce({ requestId: 'r2', action: 'submit', optionId: 'main' })
    const bridge = await createClaudeBridge('/bin/claude', {
      bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'full',
    }, vi.fn(), requestUser)
    await bridge.prompt('ask me')

    const input = {
      questions: [
        { question: 'Which approach?', options: [{ label: 'Safe' }, { label: 'Fast' }] },
        { question: 'Which branch?', options: [{ label: 'main' }, { label: 'next' }] },
      ],
    }
    // A qualified tool name reproduces bridge paths that previously missed the
    // exact-name check and auto-allowed an unanswered question in Full Access.
    const result = await queryMock.mock.calls[0][0].options.canUseTool(
      'builtin__AskUserQuestion', input, { toolUseID: 'question-1' },
    )

    expect(requestUser).toHaveBeenCalledTimes(2)
    expect(requestUser.mock.calls.map(([request]) => request.kind)).toEqual(['select', 'select'])
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'Which approach?': 'Safe', 'Which branch?': 'main' },
      },
    })
  })

  it('projects Claude task lifecycle events into todo activity snapshots', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'task_started', task_id: 'task-1', description: 'Inspect the code' }
        yield { type: 'system', subtype: 'task_started', task_id: 'ambient', description: 'Housekeeping', skip_transcript: true }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-2', description: 'Run the tests' }
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'completed' } }
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-2', patch: { status: 'failed' } }
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const bridge = await createClaudeBridge('/bin/claude', {
      bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build',
    }, emit)

    await bridge.prompt('do the work')

    const events = emit.mock.calls.map(([event]) => event)
    const starts = events.filter(event => event.type === 'tool_start' && event.toolName === 'claude_tasks')
    expect(starts).toHaveLength(1)
    expect(starts[0].args.todos).toEqual([
      { content: 'Inspect the code', status: 'in_progress', activeForm: 'Inspect the code' },
    ])

    const end = events.find(event => event.type === 'tool_end' && event.toolCallId.endsWith('-claude-tasks'))
    expect(end?.result.todos).toEqual([
      { content: 'Inspect the code', status: 'completed', activeForm: undefined },
      { content: 'Run the tests', status: 'cancelled', activeForm: undefined },
    ])
    expect(JSON.stringify(events)).not.toContain('Housekeeping')
    expect(events.indexOf(end)).toBeLessThan(events.findIndex(event => event.type === 'turn_end'))
  })

  it('completes a running Claude task when a successful turn omits task_updated', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'task_started', task_id: 'task-1', description: 'Finish the work' }
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const bridge = await createClaudeBridge('/bin/claude', {
      bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build',
    }, emit)

    await bridge.prompt('do the work')

    const end = emit.mock.calls
      .map(([event]) => event)
      .find(event => event.type === 'tool_end' && event.toolCallId.endsWith('-claude-tasks'))
    expect(end?.result.todos).toEqual([
      { content: 'Finish the work', status: 'completed', activeForm: undefined },
    ])
    expect(end?.args).toEqual(end?.result)
  })

  it('does not replay Claude tasks into the next turn', async () => {
    let turn = 0
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        turn += 1
        if (turn === 1) {
          yield { type: 'system', subtype: 'task_started', task_id: 'task-1', description: 'First turn task' }
          yield { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'completed' } }
        }
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const bridge = await createClaudeBridge('/bin/claude', {
      bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build',
    }, emit)

    await bridge.prompt('first')
    await bridge.prompt('second')

    const taskStarts = emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'tool_start' && event.toolName === 'claude_tasks')
    expect(taskStarts).toHaveLength(1)
  })

  it('routes Claude text deltas from thinking blocks to reasoning messages', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checking constraints' } },
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'final answer' } },
        }
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('run it')

    expect(emit).toHaveBeenCalledWith({ type: 'thinking_delta', bridgeId: 'b1', turnId: expect.any(String), delta: 'checking constraints' })
    expect(emit).toHaveBeenCalledWith({ type: 'text_delta', bridgeId: 'b1', turnId: expect.any(String), delta: 'final answer' })
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'text_delta', delta: 'checking constraints' }))
  })

  it('does not duplicate streamed final replies from normalized assembled messages', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'final reply ' } } }
        // The SDK's assembled block trims the streamed trailing space. This is
        // not prefix-compatible and previously replayed the entire reply.
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'final reply' }] } }
        yield { type: 'result', subtype: 'success', result: 'final reply' }
      },
    }))
    const emit = vi.fn()
    const bridge = await createClaudeBridge('/bin/claude', { bridgeId: 'b1', provider: 'claude', cwd: '/repo' }, emit)
    await bridge.prompt('run it')

    expect(emit.mock.calls.map(([event]) => event).filter(event => event.type === 'text_delta')).toEqual([{
      type: 'text_delta', bridgeId: 'b1', turnId: expect.any(String), delta: 'final reply ',
    }])
  })

  it('emits assembled Claude reasoning when partial stream events contain no readable thinking', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } }
        yield { type: 'assistant', message: { content: [{ type: 'reasoning', reasoning: 'readable assembled reasoning' }] } }
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const bridge = await createClaudeBridge('/bin/claude', {
      bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', thinking: 'high',
    }, emit)

    await bridge.prompt('run it')

    expect(emit).toHaveBeenCalledWith({
      type: 'thinking_delta', bridgeId: 'b1', turnId: expect.any(String), delta: 'readable assembled reasoning',
    })
  })

  it('does not duplicate Claude reasoning present in partial and assembled messages', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'same thought' } } }
        yield { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'same thought' }] } }
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const bridge = await createClaudeBridge('/bin/claude', { bridgeId: 'b1', provider: 'claude', cwd: '/repo' }, emit)
    await bridge.prompt('run it')

    expect(emit.mock.calls.map(([event]) => event).filter(event => event.type === 'thinking_delta')).toEqual([{
      type: 'thinking_delta', bridgeId: 'b1', turnId: expect.any(String), delta: 'same thought',
    }])
  })

  it('queues follow-up prompts while a Claude turn is running', async () => {
    let releaseFirst!: () => void
    queryMock.mockImplementation(({ prompt, options }) => ({
      options,
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        if (prompt === 'first') await new Promise<void>(resolve => { releaseFirst = resolve })
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build' }
    const bridge = await createClaudeBridge('/bin/claude', opts, vi.fn())

    const first = bridge.prompt('first')
    const followUp = await bridge.prompt('second', { streamingBehavior: 'followUp' })

    expect(followUp).toEqual({ ok: true })
    expect(queryMock).toHaveBeenCalledTimes(1)

    releaseFirst()
    await first
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock.mock.calls[1][0].prompt).toBe('second')
  })

  it('emits queue events and lets a queued follow-up be removed before it sends', async () => {
    let releaseFirst!: () => void
    queryMock.mockImplementation(({ prompt }) => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        if (prompt === 'first') await new Promise<void>(resolve => { releaseFirst = resolve })
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    const first = bridge.prompt('first')
    await bridge.prompt('second', { streamingBehavior: 'followUp' })
    await bridge.prompt('third', { streamingBehavior: 'followUp' })

    const queued = emit.mock.calls.map(([ev]) => ev).filter(ev => ev.type === 'follow_up_queued')
    expect(queued).toHaveLength(2)
    expect(queued[0].text).toBe('second')
    expect(queued[1].text).toBe('third')

    // Cancel 'second' while the first turn is still running.
    const removal = await bridge.removeFollowUp!(queued[0].followUpId)
    expect(removal).toEqual({ ok: true })
    expect(emit).toHaveBeenCalledWith({ type: 'follow_up_removed', bridgeId: 'b1', followUpId: queued[0].followUpId, reason: 'removed' })
    expect(await bridge.removeFollowUp!(queued[0].followUpId)).toEqual(expect.objectContaining({ ok: false }))

    releaseFirst()
    await first
    await new Promise(resolve => setTimeout(resolve, 0))

    // Only 'third' drains; the removed 'second' never becomes a turn.
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock.mock.calls[1][0].prompt).toBe('third')
    expect(emit).toHaveBeenCalledWith({ type: 'follow_up_removed', bridgeId: 'b1', followUpId: queued[1].followUpId, reason: 'sent' })
  })

  it('clears queued follow-ups with events when the turn is aborted', async () => {
    let releaseFirst!: () => void
    queryMock.mockImplementation(({ prompt }) => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        if (prompt === 'first') await new Promise<void>(resolve => { releaseFirst = resolve })
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    const first = bridge.prompt('first')
    await bridge.prompt('second', { streamingBehavior: 'followUp' })
    const queued = emit.mock.calls.map(([ev]) => ev).filter(ev => ev.type === 'follow_up_queued')

    await bridge.abort()
    expect(emit).toHaveBeenCalledWith({ type: 'follow_up_removed', bridgeId: 'b1', followUpId: queued[0].followUpId, reason: 'cleared' })

    releaseFirst()
    await first
    await new Promise(resolve => setTimeout(resolve, 0))
    // The cleared follow-up must not drain into a turn after the abort.
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('re-reads mode for each prompt on a reused bridge', async () => {
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build' }
    const bridge = await createClaudeBridge('/bin/claude', opts, vi.fn())

    await bridge.prompt('first')
    opts.mode = 'full'
    await bridge.prompt('second')

    expect(queryMock.mock.calls[0][0].options.permissionMode).toBe('default')
    // Full Access routes through canUseTool (default) for the tripwire, not native bypass.
    expect(queryMock.mock.calls[1][0].options.permissionMode).toBe('default')
    expect(queryMock.mock.calls[1][0].options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('auto-allows non-question tool permissions in full mode', async () => {
    const requestUser = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'full' }
    const bridge = await createClaudeBridge('/bin/claude', opts, vi.fn(), requestUser)

    await bridge.prompt('run it')
    const result = await queryMock.mock.calls[0][0].options.canUseTool('Bash', { command: 'npm test' }, { toolUseID: 'tool-1' })

    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } })
    expect(requestUser).not.toHaveBeenCalled()
  })

  it('pauses a denylisted command in full mode and blocks it when the user declines', async () => {
    const requestUser = vi.fn().mockResolvedValue({ requestId: 'r', action: 'decline', optionId: 'reject' })
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'full' }
    const bridge = await createClaudeBridge('/bin/claude', opts, vi.fn(), requestUser)

    await bridge.prompt('clean up')
    const result = await queryMock.mock.calls[0][0].options.canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 'tool-1' })

    expect(requestUser).toHaveBeenCalledTimes(1)
    expect(requestUser.mock.calls[0][0]).toMatchObject({ dangerous: true, detail: 'rm -rf /' })
    expect(result.behavior).toBe('deny')
  })

  it('runs a denylisted command in full mode when the user approves once', async () => {
    const requestUser = vi.fn().mockResolvedValue({ requestId: 'r', action: 'accept', optionId: 'allow_once' })
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'full' }
    const bridge = await createClaudeBridge('/bin/claude', opts, vi.fn(), requestUser)

    await bridge.prompt('force it')
    const result = await queryMock.mock.calls[0][0].options.canUseTool('Bash', { command: 'git push --force' }, { toolUseID: 'tool-2' })

    expect(requestUser).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'git push --force' } })
  })

  it('uses Claude SDK context usage instead of aggregate billing tokens', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      getContextUsage: vi.fn().mockResolvedValue({
        categories: [],
        totalTokens: 322_175,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 32.2,
        gridRows: [],
        model: 'claude-opus-4-8',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
      }),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4_000_000,
            cache_creation_input_tokens: 15_000,
          },
        }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', model: 'claude-opus-4-8' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('run it')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({
        inputTokens: 12,
        outputTokens: 3,
        contextTokens: 322_175,
        contextWindow: 1_000_000,
        model: 'claude-opus-4-8',
      }),
    }))
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({ contextTokens: 4_015_012 }),
    }))
  })

  it('reuses the last good SDK context reading when the control API fails', async () => {
    // getContextUsage() can fail right after a turn's result (control channel
    // racing the per-turn query shutdown). Falling back to billing math makes
    // the ctx meter bounce; the bridge must reuse the previous SDK reading.
    const goodContext = {
      categories: [],
      totalTokens: 100_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 10,
      gridRows: [],
      model: 'claude-opus-4-8',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
    }
    let turn = 0
    queryMock.mockImplementation(() => {
      turn += 1
      const failing = turn > 1
      return {
        close: vi.fn(),
        getContextUsage: failing
          ? vi.fn().mockRejectedValue(new Error('control channel closed'))
          : vi.fn().mockResolvedValue(goodContext),
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'success',
            usage: {
              input_tokens: 40,
              output_tokens: 10,
              cache_read_input_tokens: 700_000,
              cache_creation_input_tokens: 2_000,
            },
          }
        },
      }
    })
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', model: 'claude-opus-4-8' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('first')
    await bridge.prompt('second')

    const turnEnds = emit.mock.calls
      .map(([ev]) => ev)
      .filter(ev => ev.type === 'turn_end')
    expect(turnEnds).toHaveLength(2)
    // Second turn keeps the SDK gauge from turn one instead of billing math.
    expect(turnEnds[1].usage).toEqual(expect.objectContaining({
      inputTokens: 40,
      outputTokens: 10,
      contextTokens: 100_000,
      contextWindow: 1_000_000,
    }))
    // The reused reading is flagged in the breakdown so the tooltip stays honest.
    expect(turnEnds[1].usage.contextBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'sdk:reading reused from previous turn (control api unavailable)' }),
    ]))
    expect(turnEnds[0].usage.contextBreakdown ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'sdk:reading reused from previous turn (control api unavailable)' }),
    ]))
  })

  it('ignores Claude free-space/compaction-buffer categories in the live meter', async () => {
    // Claude pads `categories` so every non-deferred row sums to exactly
    // maxTokens (that is how /context draws a full grid). Counting the padding
    // reported 1,000,000 of 1,000,000 used after a single prompt.
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      getContextUsage: vi.fn().mockResolvedValue({
        categories: [
          { name: 'System prompt', tokens: 3_000, color: '#fff' },
          { name: 'System tools', tokens: 14_000, color: '#fff' },
          { name: 'Messages', tokens: 8_000, color: '#fff' },
          { name: 'Autocompact buffer', tokens: 45_000, color: '#ccc' },
          { name: 'Free space', tokens: 930_000, color: '#ccc' },
        ],
        // Claude derives totalTokens from cumulative API usage, so it can
        // exceed the window on a resumed thread.
        totalTokens: 1_240_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 124,
        gridRows: [],
        model: 'claude-opus-5',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
      }),
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 900, output_tokens: 40 } }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', model: 'claude-opus-5' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('hi')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({ contextTokens: 25_000, contextWindow: 1_000_000 }),
    }))
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({ contextTokens: 1_000_000 }),
    }))
  })

  it('never reports live context above the window', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      getContextUsage: vi.fn().mockResolvedValue({
        categories: [],
        totalTokens: 4_015_012,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 401,
        gridRows: [],
        model: 'claude-opus-5',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
      }),
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 900, output_tokens: 40 } }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', model: 'claude-opus-5' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('hi')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({ contextTokens: 1_000_000 }),
    }))
  })

  it('uses the SDK-reported Claude window when model metadata is unavailable', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      getContextUsage: vi.fn().mockResolvedValue({
        categories: [],
        totalTokens: 322_175,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 32.2,
        gridRows: [],
        model: '',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
      }),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1_200, output_tokens: 80 },
        }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('run it')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({
        contextTokens: 322_175,
        contextWindow: 1_000_000,
      }),
    }))
  })

  it('does not count deferred Claude context categories in the live meter', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      getContextUsage: vi.fn().mockResolvedValue({
        categories: [
          { name: 'messages', tokens: 17_000, color: '#fff' },
          { name: 'system', tokens: 9_000, color: '#ccc' },
          { name: 'tools', tokens: 900_000, color: '#999', isDeferred: true },
        ],
        totalTokens: 926_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 92.6,
        gridRows: [],
        model: 'claude-opus-4-8',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
      }),
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', model: 'claude-opus-4-8' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('run it')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({
        contextTokens: 26_000,
        contextWindow: 1_000_000,
        model: 'claude-opus-4-8',
      }),
    }))
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({ contextTokens: 926_000 }),
    }))
  })

  it('surfaces detailed Claude SDK context contributors', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      getContextUsage: vi.fn().mockResolvedValue({
        categories: [
          { name: 'messages', tokens: 20_000, color: '#fff' },
          { name: 'tools', tokens: 120_000, color: '#999' },
        ],
        totalTokens: 140_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 14,
        gridRows: [],
        model: 'claude-opus-4-8',
        memoryFiles: [{ path: 'AGENTS.md', type: 'project', tokens: 18_000 }],
        mcpTools: [{ name: 'search', serverName: 'linear', tokens: 80_000, isLoaded: true }],
        deferredBuiltinTools: [{ name: 'WebFetch', tokens: 25_000, isLoaded: false }],
        systemTools: [{ name: 'Bash', tokens: 12_000 }],
        systemPromptSections: [{ name: 'project-guidance', tokens: 18_000 }],
        agents: [{ agentType: 'reviewer', source: 'project', tokens: 7_000 }],
        slashCommands: { totalCommands: 12, includedCommands: 4, tokens: 9_000 },
        skills: { totalSkills: 30, includedSkills: 0, tokens: 0, skillFrontmatter: [] },
        messageBreakdown: {
          toolCallTokens: 2_000,
          toolResultTokens: 3_000,
          attachmentTokens: 4_000,
          assistantMessageTokens: 5_000,
          userMessageTokens: 6_000,
          redirectedContextTokens: 0,
          unattributedTokens: 1_000,
          toolCallsByType: [{ name: 'Read', callTokens: 800, resultTokens: 1_200 }],
          attachmentsByType: [{ name: 'image', tokens: 4_000 }],
        },
        apiUsage: { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', model: 'claude-opus-4-8' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('run it')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({
        contextTokens: 140_000,
        contextWindow: 1_000_000,
        contextBreakdown: expect.arrayContaining([
          expect.objectContaining({ name: 'sdk:totalTokens', tokens: 140_000 }),
          expect.objectContaining({ name: 'sdk:active category sum', tokens: 140_000 }),
          expect.objectContaining({ name: 'sdk:maxTokens', tokens: 1_000_000 }),
          expect.objectContaining({ name: 'mcp:linear/search', tokens: 80_000 }),
          expect.objectContaining({ name: 'builtin:WebFetch (deferred)', tokens: 25_000, deferred: true }),
          expect.objectContaining({ name: 'memory:project:AGENTS.md', tokens: 18_000 }),
          expect.objectContaining({ name: 'system:project-guidance', tokens: 18_000 }),
          expect.objectContaining({ name: 'slash commands (4/12)', tokens: 9_000 }),
          expect.objectContaining({ name: 'messages:user', tokens: 6_000 }),
          expect.objectContaining({ name: 'attachment:image', tokens: 4_000 }),
        ]),
      }),
    }))
  })

  it('falls back to Claude request context when live context usage is unavailable', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      getContextUsage: vi.fn().mockRejectedValue(new Error('control channel closed')),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4_000_000,
            cache_creation_input_tokens: 15_000,
          },
        }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build', model: 'claude-opus-4-8' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('run it')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_end',
      usage: expect.objectContaining({
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        contextTokens: 15_015,
        contextWindow: 500_000,
        model: 'claude-opus-4-8',
      }),
    }))
  })

  it('emits compaction events from Claude compact boundaries', async () => {
    queryMock.mockImplementation(() => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 151_000, post_tokens: 24_000 },
        }
        yield { type: 'result', subtype: 'success' }
      },
    }))
    const emit = vi.fn()
    const opts: BridgeStartOpts = { bridgeId: 'b1', provider: 'claude', cwd: '/repo', mode: 'build' }
    const bridge = await createClaudeBridge('/bin/claude', opts, emit)

    await bridge.prompt('run it')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'compaction_event',
      bridgeId: 'b1',
      status: 'completed',
      automatic: true,
      provider: 'claude',
      beforeTokens: 151_000,
      afterTokens: 24_000,
    }))
  })
})
