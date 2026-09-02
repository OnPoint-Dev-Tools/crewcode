import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it, vi } from 'vitest'
import { CREWCODE_BRAIN_DESKTOP_VERSION, type BrainDesktopConnection } from '../shared/brain-desktop-types'
import {
  brainDesktopConnectionPath,
  readBrainDesktopConnection,
  removeBrainDesktopConnection,
  writeBrainDesktopConnection,
} from './brain-desktop-rendezvous'
import { BrainDesktopService, seedBrainRuntime } from './brain-desktop-service'
import { createMachineIdentity, machineCredentialPath, writeMachineCredential } from './hub-machine-enrollment'

function fixture(): { root: string; desktop: string; brain: string } {
  const root = mkdtempSync(join(tmpdir(), 'crewcode-desktop-brain-'))
  const desktop = join(root, 'desktop')
  const brain = join(root, 'brain')
  mkdirSync(desktop, { recursive: true })
  mkdirSync(brain, { recursive: true })
  return { root, desktop, brain }
}

function connection(controlToken = 'c'.repeat(43)): BrainDesktopConnection {
  return {
    version: CREWCODE_BRAIN_DESKTOP_VERSION,
    pid: 1234,
    url: 'http://127.0.0.1:41111',
    sessionToken: `session.${'s'.repeat(43)}`,
    controlToken,
    startedAt: Date.now(),
  }
}

function enroll(brain: string, hubOrigin = 'http://127.0.0.1:3774'): void {
  const machineId = 'a'.repeat(32)
  writeMachineCredential(machineCredentialPath(brain), {
    version: 1,
    hubOrigin,
    machineId,
    token: `${machineId}.${Buffer.alloc(32, 7).toString('base64url')}`,
    ...createMachineIdentity(),
    enrolledAt: 1_000,
  })
}

describe('desktop Brain lifecycle', () => {
  it('publishes an owner-local rendezvous and only its owner removes it', () => {
    const { root, brain } = fixture()
    const path = brainDesktopConnectionPath(brain)
    try {
      writeBrainDesktopConnection(path, connection())
      expect(readBrainDesktopConnection(path)).toMatchObject({ pid: 1234, url: 'http://127.0.0.1:41111' })
      removeBrainDesktopConnection(path, 'wrong-token')
      expect(readBrainDesktopConnection(path)).not.toBeNull()
      removeBrainDesktopConnection(path, 'c'.repeat(43))
      expect(readBrainDesktopConnection(path)).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('seeds a fresh Brain once without overwriting Brain-authoritative state', () => {
    const { root, desktop, brain } = fixture()
    try {
      writeFileSync(join(desktop, 'workspaces.json'), '{"workspaces":[{"id":"desktop"}]}')
      mkdirSync(join(desktop, 'transcripts'))
      writeFileSync(join(desktop, 'transcripts', 'transcript.one.json'), '{"scopeId":"one","messages":[]}')
      mkdirSync(join(desktop, 'conversations'))
      writeFileSync(join(desktop, 'conversations', 'agent-conversations.desktop.json'), JSON.stringify({
        conversations: { 'thread:session-one': [{ role: 'user', content: 'Continue me' }] },
      }))
      seedBrainRuntime(desktop, brain)
      expect(readFileSync(join(brain, 'runtime', 'workspaces.json'), 'utf8')).toContain('desktop')
      expect(readFileSync(join(brain, 'runtime', 'transcripts', 'transcript.one.json'), 'utf8')).toContain('scopeId')
      const migratedReplay = readdirSync(join(brain, 'runtime', 'conversations'))
        .map(name => readFileSync(join(brain, 'runtime', 'conversations', name), 'utf8'))
        .find(contents => contents.includes('web:session-one'))
      expect(migratedReplay).toContain('Continue me')

      writeFileSync(join(brain, 'runtime', 'workspaces.json'), '{"workspaces":[{"id":"brain"}]}')
      writeFileSync(join(desktop, 'workspaces.json'), '{"workspaces":[{"id":"changed-desktop"}]}')
      seedBrainRuntime(desktop, brain)
      expect(readFileSync(join(brain, 'runtime', 'workspaces.json'), 'utf8')).toContain('brain')
      expect(readFileSync(join(brain, 'runtime', 'workspaces.json'), 'utf8')).not.toContain('changed-desktop')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('merges a newer desktop transcript into an existing Brain shard', () => {
    const { root, desktop, brain } = fixture()
    try {
      mkdirSync(join(desktop, 'transcripts'))
      mkdirSync(join(brain, 'runtime', 'transcripts'), { recursive: true })
      writeFileSync(join(brain, 'runtime', 'transcripts', 'transcript.one.json'), JSON.stringify({
        scopeId: 'one',
        messages: [{ kind: 'user', text: 'seeded turn' }],
      }))
      writeFileSync(join(desktop, 'transcripts', 'transcript.one.json'), JSON.stringify({
        scopeId: 'one',
        messages: [{ kind: 'user', text: 'seeded turn' }, { kind: 'user', text: 'desktop turn from today' }],
      }))
      seedBrainRuntime(desktop, brain)
      const merged = JSON.parse(readFileSync(join(brain, 'runtime', 'transcripts', 'transcript.one.json'), 'utf8')) as {
        messages: Array<{ text: string }>
      }
      expect(merged.messages.map(message => message.text)).toEqual(['seeded turn', 'desktop turn from today'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('starts, probes, and explicitly stops the detached Brain', async () => {
    const { root, desktop, brain } = fixture()
    const descriptor = connection()
    let live = true
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api/v1/desktop/status')) {
        if (!live) throw new Error('stopped')
        return new Response(JSON.stringify({ ok: true, pid: descriptor.pid }), { status: 200 })
      }
      if (url.endsWith('/api/v1/desktop/stop')) { live = false; return new Response(JSON.stringify({ ok: true }), { status: 202 }) }
      throw new Error(`unexpected URL ${url}`)
    }) as unknown as typeof fetch
    const unref = vi.fn()
    const spawnProcess = vi.fn(() => {
      writeBrainDesktopConnection(brainDesktopConnectionPath(brain), descriptor)
      return { unref } as never
    })
    enroll(brain)
    const service = new BrainDesktopService({
      dataDir: brain,
      desktopDataDir: desktop,
      packaged: false,
      executable: '/electron',
      brainEntry: '/out/main/brain.js',
      spawnProcess,
      fetchImpl,
    })
    try {
      await expect(service.setEnabled(true)).resolves.toMatchObject({
        enabled: true,
        enrolled: true,
        hubOrigin: 'http://127.0.0.1:3774',
        running: true,
        attached: true,
      })
      expect(spawnProcess).toHaveBeenCalledWith('/electron', expect.arrayContaining(['/out/main/brain.js', '--desktop-background']), expect.objectContaining({ detached: true }))
      expect(unref).toHaveBeenCalled()
      await expect(service.stop()).resolves.toMatchObject({ enabled: false })
      expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/v1/desktop/stop'), expect.objectContaining({ method: 'POST' }))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reports the enrolled Hub origin without exposing machine credentials', async () => {
    const { root, desktop, brain } = fixture()
    enroll(brain, 'https://hub.example')
    const service = new BrainDesktopService({
      dataDir: brain,
      desktopDataDir: desktop,
      packaged: false,
      executable: '/electron',
      brainEntry: '/out/main/brain.js',
    })
    try {
      const status = await service.status()
      expect(status).toEqual(expect.objectContaining({ enrolled: true, hubOrigin: 'https://hub.example' }))
      expect(JSON.stringify(status)).not.toContain('token')
      expect(JSON.stringify(status)).not.toContain('privateKey')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('observes the exact Hub browser origin separately from its enrollment address', async () => {
    const { root, desktop, brain } = fixture()
    enroll(brain, 'http://127.0.0.1:3774')
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'http://127.0.0.1:3774/api/v1/hub/status') {
        return new Response(JSON.stringify({
          service: 'crewcode-hub',
          protocolVersion: 1,
          ownerConfigured: true,
          publicOrigin: 'http://localhost:3774',
        }), { status: 200 })
      }
      throw new Error(`unexpected URL ${String(input)}`)
    }) as unknown as typeof fetch
    const service = new BrainDesktopService({
      dataDir: brain,
      desktopDataDir: desktop,
      packaged: false,
      executable: '/electron',
      brainEntry: '/out/main/brain.js',
      fetchImpl,
    })
    try {
      await expect(service.status(true)).resolves.toEqual(expect.objectContaining({
        hubOrigin: 'http://127.0.0.1:3774',
        hubBrowserOrigin: 'http://localhost:3774',
        hubReachable: true,
      }))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
