import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AgentBridgeService, bridgeSessionStorageKey, webConversationKey } from './bridge-service'
import type { AgentBridgeFactory } from './bridge-service'
import type { BridgeEvent } from './bridge-types'
import { loadConversation, saveConversation } from './conversation-store'

describe('AgentBridgeService', () => {
  it('keeps Brain native-resume ids provider-specific and migration-compatible', () => {
    expect(bridgeSessionStorageKey('web:session-one', 'codex')).toBe('session-one:codex')
    expect(bridgeSessionStorageKey('web:session-one', 'claude')).toBe('session-one:claude')
    expect(bridgeSessionStorageKey('thread:session-one', 'codex')).toBe('session-one:codex')
    expect(webConversationKey('session-one')).toBe('web:session-one')
    expect(webConversationKey('thread:session-one')).toBe('web:session-one')
    expect(webConversationKey('web:session-one')).toBe('web:session-one')
  })

  it('coalesces simultaneous first starts for one stable remote bridge', async () => {
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    const factory = vi.fn<AgentBridgeFactory>(async (_path, opts) => {
      await createGate
      return {
        bridgeId: opts.bridgeId,
        pid: null,
        prompt: async () => ({ ok: true }),
        abort: async () => undefined,
        stop: async () => undefined,
      }
    })
    const service = new AgentBridgeService(() => '/bin/fake-agent', factory)
    const opts = { bridgeId: 'shared-stable-bridge', provider: 'codex' as const, cwd: '/tmp' }

    const desktopStart = service.start(opts)
    const browserStart = service.start(opts)
    releaseCreate()

    await expect(Promise.all([desktopStart, browserStart])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(factory).toHaveBeenCalledTimes(1)
    await service.stopAll()
  })

  it('serializes prompts from different clients that target one conversation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crewcode-conversation-queue-'))
    const previousDataDir = process.env.CREWCODE_DATA_DIR
    process.env.CREWCODE_DATA_DIR = dataDir
    const prompts: string[] = []
    const emitters = new Map<string, Parameters<AgentBridgeFactory>[2]>()
    const factory: AgentBridgeFactory = async (_path, opts, emit) => {
      emitters.set(opts.bridgeId, emit)
      return {
        bridgeId: opts.bridgeId,
        pid: null,
        prompt: async text => { prompts.push(`${opts.bridgeId}:${text}`); return { ok: true } },
        abort: async () => undefined,
        stop: async () => undefined,
      }
    }
    const service = new AgentBridgeService(() => '/bin/fake-agent', factory)
    const events: Array<{ type: string; bridgeId?: string; reason?: string }> = []
    service.subscribe(event => events.push(event))
    try {
      await service.start({ bridgeId: 'desktop', provider: 'codex', cwd: '/tmp', conversationKey: 'web:shared-serialization' })
      await service.start({ bridgeId: 'browser', provider: 'claude', cwd: '/tmp', conversationKey: 'web:shared-serialization' })

      await expect(service.prompt('desktop', 'first')).resolves.toEqual({ ok: true })
      await expect(service.prompt('browser', 'second')).resolves.toEqual({ ok: true })
      expect(prompts).toEqual(['desktop:first'])
      expect(events).toContainEqual(expect.objectContaining({ type: 'follow_up_queued', bridgeId: 'browser' }))

      emitters.get('desktop')?.({ type: 'turn_start', bridgeId: 'desktop', turnId: 'desktop-turn' })
      emitters.get('desktop')?.({ type: 'turn_end', bridgeId: 'desktop', turnId: 'desktop-turn' })
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(prompts).toEqual(['desktop:first', 'browser:second'])
      expect(events).toContainEqual(expect.objectContaining({ type: 'follow_up_removed', bridgeId: 'browser', reason: 'sent' }))
    } finally {
      await service.stopAll()
      if (previousDataDir === undefined) delete process.env.CREWCODE_DATA_DIR
      else process.env.CREWCODE_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('removes a Brain-queued prompt before it reaches the provider', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crewcode-conversation-remove-'))
    const previousDataDir = process.env.CREWCODE_DATA_DIR
    process.env.CREWCODE_DATA_DIR = dataDir
    const prompts: string[] = []
    const factory: AgentBridgeFactory = async (_path, opts) => ({
      bridgeId: opts.bridgeId,
      pid: null,
      prompt: async text => { prompts.push(text); return { ok: true } },
      abort: async () => undefined,
      stop: async () => undefined,
    })
    const service = new AgentBridgeService(() => '/bin/fake-agent', factory)
    let queuedId = ''
    service.subscribe(event => { if (event.type === 'follow_up_queued') queuedId = event.followUpId })
    try {
      await service.start({ bridgeId: 'shared', provider: 'codex', cwd: '/tmp', conversationKey: 'web:shared-removal' })

      await service.prompt('shared', 'first')
      await service.prompt('shared', 'second')
      expect(queuedId).toBeTruthy()
      await expect(service.removeFollowUp('shared', queuedId)).resolves.toEqual({ ok: true })
      expect(prompts).toEqual(['first'])
    } finally {
      await service.stopAll()
      if (previousDataDir === undefined) delete process.env.CREWCODE_DATA_DIR
      else process.env.CREWCODE_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects unknown and plugin providers before resolving a path', async () => {
    const resolvePath = vi.fn(() => '/bin/agent')
    const service = new AgentBridgeService(resolvePath)
    await expect(service.start({ bridgeId: 'unknown', provider: 'plugin:test', cwd: '/tmp' })).resolves.toEqual({ error: 'agent provider is not available over remote access' })
    expect(resolvePath).not.toHaveBeenCalled()
  })

  it('reports missing local provider binaries without starting a bridge', async () => {
    const service = new AgentBridgeService(() => null)
    await expect(service.start({ bridgeId: 'codex', provider: 'codex', cwd: '/tmp' })).resolves.toEqual({ error: 'codex not found on this machine' })
  })

  it('returns bounded lifecycle results for absent bridges', async () => {
    const service = new AgentBridgeService(() => null)
    await expect(service.prompt('missing', 'hello')).resolves.toEqual({ ok: false, error: 'bridge not found' })
    await expect(service.abort('missing')).resolves.toEqual({ ok: true })
    await expect(service.stop('missing')).resolves.toEqual({ ok: true })
  })

  it('stores a native compact summary without replacing the durable provider session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crewcode-native-compact-'))
    const previousDataDir = process.env.CREWCODE_DATA_DIR
    process.env.CREWCODE_DATA_DIR = dataDir
    const conversationKey = `web:native-compact-${Date.now().toString(36)}`
    const stop = vi.fn(async () => undefined)
    const factory: AgentBridgeFactory = async (_path, opts) => ({
      bridgeId: opts.bridgeId,
      pid: null,
      prompt: async () => ({ ok: true }),
      compact: async () => ({ ok: true, compacted: true, summary: 'Durable CrewCoder summary.' }),
      abort: async () => undefined,
      stop,
    })
    const service = new AgentBridgeService(() => '/bin/fake-agent', factory)
    const events: BridgeEvent[] = []
    service.subscribe(event => events.push(event))
    try {
      saveConversation(conversationKey, [{ role: 'user', content: 'Original history.' }])
      await service.start({ bridgeId: 'crewcoder', provider: 'crewcoder', cwd: '/tmp', conversationKey })

      await expect(service.compact('crewcoder')).resolves.toEqual({ ok: true, error: undefined, unsupported: undefined })
      expect(loadConversation(conversationKey)).toEqual([
        { role: 'user', content: 'Continue from this compacted conversation summary.' },
        { role: 'assistant', content: 'Durable CrewCoder summary.' },
      ])
      expect(events).toContainEqual(expect.objectContaining({
        type: 'handoff_summary',
        bridgeId: 'crewcoder',
        summary: 'Durable CrewCoder summary.',
        reason: 'compact',
      }))
      expect(stop).not.toHaveBeenCalled()
    } finally {
      await service.stopAll()
      if (previousDataDir === undefined) delete process.env.CREWCODE_DATA_DIR
      else process.env.CREWCODE_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('treats a duplicate stable start as an attach without stopping the provider', async () => {
    const service = new AgentBridgeService(() => null)
    const stop = vi.spyOn(service, 'stop')
    const opts = { bridgeId: 'stable-web-bridge', provider: 'ollama' as const, cwd: '/tmp', model: 'test-model' }
    const dataDir = mkdtempSync(join(tmpdir(), 'crewcode-bridge-service-'))
    const previousDataDir = process.env.CREWCODE_DATA_DIR
    process.env.CREWCODE_DATA_DIR = dataDir

    try {
      await expect(service.start(opts)).resolves.toEqual({ ok: true })
      expect(stop).toHaveBeenCalledTimes(1)
      await expect(service.start(opts)).resolves.toEqual({ ok: true })
      expect(stop).toHaveBeenCalledTimes(1)
      await expect(service.start({ ...opts, model: 'different-model' })).resolves.toEqual({
        error: 'bridge already exists with different execution configuration; stop it before restarting',
      })
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      await service.stop(opts.bridgeId)
      if (previousDataDir === undefined) delete process.env.CREWCODE_DATA_DIR
      else process.env.CREWCODE_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('summarizes one browser thread into another and replays the destination history once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crewcode-browser-handoff-'))
    const previousDataDir = process.env.CREWCODE_DATA_DIR
    process.env.CREWCODE_DATA_DIR = dataDir
    const sourceKey = `web:source-${Date.now().toString(36)}`
    const targetKey = `web:target-${Date.now().toString(36)}`
    const prompts = new Map<string, string[]>()
    const stopped: string[] = []
    const factory: AgentBridgeFactory = async (_path, opts, emit) => ({
      bridgeId: opts.bridgeId,
      pid: null,
      prompt: async text => {
        prompts.set(opts.bridgeId, [...(prompts.get(opts.bridgeId) ?? []), text])
        const turnId = `${opts.bridgeId}-turn`
        emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId })
        emit({
          type: 'text_delta',
          bridgeId: opts.bridgeId,
          turnId,
          delta: opts.bridgeId.includes('-handoff-') ? 'Keep the architecture decision and continue with tests.' : 'continued',
        })
        emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId })
        return { ok: true }
      },
      abort: async () => undefined,
      stop: async () => { stopped.push(opts.bridgeId) },
    })
    const service = new AgentBridgeService(() => '/bin/fake-agent', factory)
    const events: string[] = []
    service.subscribe(event => events.push(event.type))

    try {
      saveConversation(sourceKey, [
        { role: 'user', content: 'Keep this architecture decision.' },
        { role: 'assistant', content: 'I will preserve it.' },
      ])
      saveConversation(targetKey, [{ role: 'user', content: 'Existing destination context.' }])
      await expect(service.start({ bridgeId: 'target', provider: 'codex', cwd: '/tmp', conversationKey: targetKey, freshSession: true }))
        .resolves.toEqual({ ok: true })

      await expect(service.handoff('target', sourceKey, {
        fromProvider: 'claude',
        toProvider: 'codex',
        workspace: { name: 'CrewCode', path: '/tmp', branch: 'dev' },
      })).resolves.toEqual({ ok: true })

      expect(loadConversation(targetKey)).toEqual([
        { role: 'user', content: 'Existing destination context.' },
        { role: 'user', content: 'CrewCode context handoff from claude. Continue with the imported context alongside this chat\'s existing history.' },
        { role: 'assistant', content: 'Keep the architecture decision and continue with tests.' },
      ])
      expect(events).toContain('handoff_summary')
      expect(events).toContain('idle_stopped')
      expect(stopped).toContain('target')

      await service.start({ bridgeId: 'target-next', provider: 'codex', cwd: '/tmp', conversationKey: targetKey })
      await service.prompt('target-next', 'What comes next?')
    } finally {
      await service.stopAll()
      if (previousDataDir === undefined) delete process.env.CREWCODE_DATA_DIR
      else process.env.CREWCODE_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }

    const replayedPrompt = prompts.get('target-next')?.[0] ?? ''
    expect(replayedPrompt).toContain('<conversation_history>')
    expect(replayedPrompt).toContain('Keep the architecture decision and continue with tests.')
    expect(replayedPrompt).toContain('What comes next?')
  })
})
