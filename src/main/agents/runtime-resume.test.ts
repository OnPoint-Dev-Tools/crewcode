import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentBridgeService, type AgentBridgeFactory } from './bridge-service'

describe('runtime Stop and resume', () => {
  it.each(['codex', 'crewcoder', 'claude', 'pi', 'opencode', 'hermes', 'grok'] as const)(
    'keeps the %s native session id and waits for a new user message', async provider => {
      const directory = mkdtempSync(join(tmpdir(), 'crewcode-stop-resume-'))
      const previous = process.env.CREWCODE_DATA_DIR
      process.env.CREWCODE_DATA_DIR = directory
      const launches: Array<string | undefined> = []
      const prompts: string[] = []
      const factory: AgentBridgeFactory = async (_path, opts, emit) => {
        launches.push(opts.resumeSessionId)
        emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId: 'durable-native-session', resumed: !!opts.resumeSessionId })
        return {
          bridgeId: opts.bridgeId, pid: null,
          prompt: async text => { prompts.push(text); return { ok: true } },
          abort: async () => {}, stop: async () => {},
        }
      }
      const service = new AgentBridgeService(() => '/fake-agent', factory)
      const conversationKey = `web:stop-resume-${provider}`
      try {
        await service.start({ bridgeId: 'before-stop', provider, cwd: directory, conversationKey })
        await service.prompt('before-stop', 'original request')
        await service.stop('before-stop')
        await service.start({ bridgeId: 'after-stop', provider, cwd: directory, conversationKey })
        expect(launches).toEqual([undefined, 'durable-native-session'])
        expect(prompts).toEqual(['original request'])
        await service.prompt('after-stop', 'continue safely')
        expect(prompts).toEqual(['original request', 'continue safely'])
      } finally {
        await service.stopAll()
        if (previous === undefined) delete process.env.CREWCODE_DATA_DIR
        else process.env.CREWCODE_DATA_DIR = previous
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
