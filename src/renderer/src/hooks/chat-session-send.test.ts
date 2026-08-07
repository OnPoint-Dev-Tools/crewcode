import { describe, expect, it, vi } from 'vitest'

import type { AgentInfo, Message, ModeLevel } from '../types'
import { sendChatSessionPrompt } from './chat-session-send'

const bridgeAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  path: '/usr/bin/codex',
  available: true,
  transport: 'bridge',
}

const ptyAgent: AgentInfo = {
  id: 'claude',
  name: 'Claude',
  path: '/usr/bin/claude',
  available: true,
  transport: 'pty',
}

function messageHarness() {
  let messages: Message[] = []
  return {
    get messages() { return messages },
    setMessages(updater: (prev: Message[]) => Message[]) {
      messages = updater(messages)
    },
  }
}

function makeBaseOpts(mode: ModeLevel, messages: ReturnType<typeof messageHarness>) {
  return {
    text: 'please help',
    activeWs: 'ws-1',
    activeTabId: 'tab-1',
    sessActive: 'sess-1',
    setMessages: messages.setMessages,
    agents: [bridgeAgent],
    activeAgentId: bridgeAgent.id,
    model: 'gpt-5.4',
    effort: 'medium' as const,
    mode,
    effectivePath: '/repo',
    bridges: {
      ensureBridge: vi.fn(async () => ({ bridgeId: 'bridge-1' })),
      prompt: vi.fn(async () => ({ ok: true })),
    },
    pty: {
      addAgent: vi.fn(() => ({ paneId: 'pane-1', live: true })),
      write: vi.fn(),
    },
    activeAgentPane: null,
    enabledSkills: [],
    skillsDeliveredTo: vi.fn(() => []),
    markSkillsDelivered: vi.fn(),
    lastDeliveredMode: vi.fn(() => undefined as ModeLevel | undefined),
    markModeDelivered: vi.fn(),
    sessionHasExistingMessages: false,
  }
}

describe('sendChatSessionPrompt mode handling', () => {
  it.each([
    ['ask', "operating exclusively in 'Ask Mode'", 'You MUST NOT write executable code blocks'],
    ['plan', "operating in 'Plan Mode.'", 'never write production code, execute commands, or make file changes'],
    ['build', 'You are in Build mode', 'integrated developer agent'],
    ['full', "operating in 'Full Access Mode'", 'NEVER ask for permission'],
  ] as const)('injects the %s mode preamble and passes the mode to bridge startup', async (mode, heading, body) => {
    const messages = messageHarness()
    const opts = makeBaseOpts(mode, messages)

    await sendChatSessionPrompt(opts)

    expect(opts.bridges.ensureBridge).toHaveBeenCalledWith(
      'sess-1',
      'codex',
      'codex',
      '/repo',
      'gpt-5.4',
      'medium',
      mode,
      undefined, // toolPolicy — normal chats use provider default
      false,
      [],   // mcpServers — none selected in the base harness
      false,
      undefined, // externalDirectories — none selected in the base harness
    )
    expect(opts.bridges.prompt).toHaveBeenCalledOnce()
    const promptCalls = (opts.bridges.prompt as unknown as { mock: { calls: Array<[string, string]> } }).mock.calls
    const wireText = promptCalls[0][1]
    expect(wireText).toContain(heading)
    expect(wireText).toContain(body)
    expect(wireText).toMatch(/please help$/)
    expect(opts.markModeDelivered).toHaveBeenCalledWith('sess-1', mode)
    expect(messages.messages).toContainEqual(expect.objectContaining({
      kind: 'system',
      tone: 'info',
      text: expect.stringContaining(`mode: ${mode.toUpperCase()}`),
    }))
  })

  it('uses provider-native context when CrewCode mode prompts are disabled', async () => {
    const messages = messageHarness()
    const opts = {
      ...makeBaseOpts('build', messages),
      modePromptsEnabled: false,
    }

    await sendChatSessionPrompt(opts)

    expect(opts.bridges.ensureBridge).toHaveBeenCalledWith(
      'sess-1', 'codex', 'codex', '/repo', 'gpt-5.4', 'medium', 'build', undefined, false, [], false, undefined,
    )
    expect(opts.bridges.prompt).toHaveBeenCalledWith('bridge-1', 'please help', undefined)
    expect(opts.markModeDelivered).toHaveBeenCalledWith('sess-1', 'build')
  })

  it('injects the custom prompt selected for the active mode', async () => {
    const messages = messageHarness()
    const opts = {
      ...makeBaseOpts('plan', messages),
      modePrompts: {
        ask: 'custom ask',
        plan: 'custom plan',
        build: 'custom build',
        full: 'custom full',
      },
    }

    await sendChatSessionPrompt(opts)

    expect(opts.bridges.prompt).toHaveBeenCalledWith(
      'bridge-1',
      'custom plan\n\nplease help',
      undefined,
    )
  })

  it('does not repeat the mode preamble or visible notice when the same mode was already recorded', async () => {
    const messages = messageHarness()
    const opts = makeBaseOpts('build', messages)
    opts.lastDeliveredMode = vi.fn(() => 'build')

    await sendChatSessionPrompt(opts)

    expect(opts.markModeDelivered).not.toHaveBeenCalled()
    expect(messages.messages.filter(m => m.kind === 'system' && m.text.startsWith('mode:'))).toHaveLength(0)
    const promptCalls = (opts.bridges.prompt as unknown as { mock: { calls: Array<[string, string]> } }).mock.calls
    expect(promptCalls[0][1]).not.toContain('You are in Build mode')
    expect(promptCalls[0][1]).toBe('please help')
  })

  it('announces mode changes without re-injecting session-start prompt material', async () => {
    const messages = messageHarness()
    const opts = makeBaseOpts('full', messages)
    opts.lastDeliveredMode = vi.fn(() => 'build')

    await sendChatSessionPrompt(opts)

    expect(opts.markModeDelivered).toHaveBeenCalledWith('sess-1', 'full')
    expect(messages.messages).toContainEqual(expect.objectContaining({
      kind: 'system',
      tone: 'info',
      text: expect.stringContaining('mode: FULL'),
    }))
    const promptCalls = (opts.bridges.prompt as unknown as { mock: { calls: Array<[string, string]> } }).mock.calls
    expect(promptCalls[0][1]).not.toContain('You are in FULL mode')
    expect(promptCalls[0][1]).toBe('please help')
  })

  it('seeds mode delivery for restored sessions without resending the mode prompt', async () => {
    const messages = messageHarness()
    const opts = makeBaseOpts('build', messages)
    opts.sessionHasExistingMessages = true

    await sendChatSessionPrompt(opts)

    expect(opts.markModeDelivered).toHaveBeenCalledWith('sess-1', 'build')
    expect(messages.messages.filter(m => m.kind === 'system' && m.text.startsWith('mode:'))).toHaveLength(0)
    const promptCalls = (opts.bridges.prompt as unknown as { mock: { calls: Array<[string, string]> } }).mock.calls
    expect(promptCalls[0][1]).not.toContain('You are in Build mode')
    expect(promptCalls[0][1]).toBe('please help')
  })

  it('shows and completes a handoff meter when switching bridge providers', async () => {
    const messages = messageHarness()
    const opts = {
      ...makeBaseOpts('build', messages),
      promptOptions: {
        handoff: {
          fromProvider: 'claude',
          toProvider: 'codex',
          model: 'gpt-5.4',
          mode: 'build' as const,
          workspace: { name: 'CrewCode', path: '/repo', branch: 'main' },
        },
      },
    }

    await sendChatSessionPrompt(opts)

    expect(opts.bridges.ensureBridge).toHaveBeenCalledWith(
      'sess-1', 'codex', 'codex', '/repo', 'gpt-5.4', 'medium', 'build', undefined, false, [], true, undefined,
    )
    expect(opts.bridges.prompt).toHaveBeenCalledWith('bridge-1', expect.any(String), opts.promptOptions)
    const handoff = messages.messages.find(m => m.kind === 'handoff')
    expect(handoff).toEqual(expect.objectContaining({
      kind: 'handoff',
      status: 'completed',
      message: 'handoff complete',
      fromProvider: 'claude',
      toProvider: 'codex',
      percent: 100,
    }))
  })

  it('writes the selected mode preamble to pty agents too', async () => {
    const messages = messageHarness()
    const opts = {
      ...makeBaseOpts('plan', messages),
      agents: [ptyAgent],
      activeAgentId: ptyAgent.id,
    }

    await sendChatSessionPrompt(opts)

    expect(opts.pty.addAgent).toHaveBeenCalledWith('ws-1', 'tab-1', 'claude', 'Claude', '/repo', '/usr/bin/claude')
    expect(opts.pty.write).toHaveBeenCalledWith(
      'pane-1',
      expect.stringContaining("operating in 'Plan Mode.'"),
    )
    expect(opts.bridges.ensureBridge).not.toHaveBeenCalled()
  })
})
