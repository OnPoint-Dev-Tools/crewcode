import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'child_process'
import {
  credentialTargetsHub,
  ensureLocalBrainEnrollment,
  localBrainArgv,
  localBrainSpawnPlan,
  sameHubOrigin,
  superviseLocalBrain,
  waitForHubOwner,
  type LocalBrainHub,
} from './hub-local-brain'
import { createMachineIdentity, machineCredentialPath, writeMachineCredential, type MachineCredentialFile } from './hub-machine-enrollment'

const directories: string[] = []
afterEach(() => {
  while (directories.length) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'crewcode-local-brain-'))
  directories.push(value)
  return value
}

function credential(overrides: Partial<MachineCredentialFile> = {}): MachineCredentialFile {
  const identity = createMachineIdentity()
  return {
    version: 1,
    hubOrigin: 'http://127.0.0.1:3774',
    machineId: 'a'.repeat(32),
    token: `${'a'.repeat(32)}.${Buffer.alloc(32, 7).toString('base64url')}`,
    enrolledAt: 1_000,
    ...identity,
    ...overrides,
  }
}

describe('local Brain Hub origin matching', () => {
  it('treats loopback hostnames on the same port as one Hub', () => {
    expect(sameHubOrigin('http://127.0.0.1:3774', 'http://localhost:3774')).toBe(true)
    expect(sameHubOrigin('http://127.0.0.1:3774', 'http://127.0.0.1:3775')).toBe(false)
    expect(sameHubOrigin('https://crewcode.example', 'https://crewcode.example')).toBe(true)
    expect(sameHubOrigin('http://127.0.0.1:3774', 'https://crewcode.example')).toBe(false)
  })
})

describe('local Brain spawn plan', () => {
  it('spawns sibling brain.js from a compiled Hub entry', () => {
    expect(localBrainSpawnPlan({
      execPath: '/usr/bin/node',
      scriptPath: '/opt/crewcode/out/main/hub.js',
      brainArgv: ['--data-dir', '/brain'],
    })).toEqual({
      execPath: '/usr/bin/node',
      args: ['/opt/crewcode/out/main/brain.js', '--data-dir', '/brain'],
    })
  })

  it('re-invokes the checkout CLI wrapper for brain', () => {
    expect(localBrainSpawnPlan({
      execPath: '/usr/bin/node',
      scriptPath: '/opt/crewcode/bin/crewcode-server.mjs',
      brainArgv: ['--data-dir', '/brain'],
    })).toEqual({
      execPath: '/usr/bin/node',
      args: ['/opt/crewcode/bin/crewcode-server.mjs', 'brain', '--data-dir', '/brain'],
    })
  })

  it('uses the packaged executable command form', () => {
    expect(localBrainSpawnPlan({
      execPath: '/opt/CrewCode/crewcode',
      scriptPath: 'hub',
      brainArgv: ['--data-dir', '/brain'],
    })).toEqual({
      execPath: '/opt/CrewCode/crewcode',
      args: ['brain', '--data-dir', '/brain'],
    })
  })

  it('forwards workspace roots and scopes to the sibling Brain', () => {
    expect(localBrainArgv({
      dataDir: '/brain',
      name: 'vps',
      allowedWorkspaceRoots: ['/src'],
      allowedScopes: ['workspace:read', 'agent'],
    })).toEqual([
      '--data-dir', '/brain',
      '--workspace-root', '/src',
      '--allow-scope', 'workspace:read',
      '--allow-scope', 'agent',
    ])
  })
})

describe('local Brain enrollment', () => {
  it('reuses a credential for this Hub and refuses a foreign Hub', () => {
    const dataDir = directory()
    const existing = credential()
    writeMachineCredential(machineCredentialPath(dataDir), existing)
    const hub: LocalBrainHub = {
      url: 'http://localhost:3774',
      publicOrigin: 'https://crewcode.example',
      ownerConfigured: () => true,
      enrollLocalMachine: () => { throw new Error('should reuse') },
    }
    expect(ensureLocalBrainEnrollment(hub, { dataDir, name: 'vps' }).created).toBe(false)
    expect(credentialTargetsHub(existing, hub)).toBe(true)

    const foreign = credential({
      hubOrigin: 'https://other.example',
      machineId: 'b'.repeat(32),
      token: `${'b'.repeat(32)}.${Buffer.alloc(32, 8).toString('base64url')}`,
    })
    const otherDir = directory()
    writeMachineCredential(machineCredentialPath(otherDir), foreign)
    expect(() => ensureLocalBrainEnrollment(hub, { dataDir: otherDir, name: 'vps' })).toThrow('not this Hub')
  })

  it('enrolls once the owner exists and writes an owner-only credential', () => {
    const dataDir = directory()
    const identity = createMachineIdentity()
    const hub: LocalBrainHub = {
      url: 'http://127.0.0.1:3774',
      publicOrigin: 'https://crewcode.example',
      ownerConfigured: () => true,
      enrollLocalMachine: input => {
        expect(input.publicKey).toBeTruthy()
        expect(input.name).toBe('vps')
        return { machineId: 'c'.repeat(32), token: `${'c'.repeat(32)}.${Buffer.alloc(32, 9).toString('base64url')}` }
      },
    }
    const result = ensureLocalBrainEnrollment(hub, { dataDir, name: 'vps' })
    expect(result.created).toBe(true)
    expect(result.credential.hubOrigin).toBe('http://127.0.0.1:3774')
    expect(result.credential.machineId).toBe('c'.repeat(32))
    expect(identity.publicKey).not.toBe(result.credential.publicKey)
  })

  it('waits for owner configuration before continuing', async () => {
    let ready = false
    let waited = 0
    await waitForHubOwner({ ownerConfigured: () => ready }, {
      sleep: async () => {
        waited += 1
        ready = true
      },
    })
    expect(waited).toBe(1)
  })
})

describe('local Brain supervisor', () => {
  it('spawns the sibling Brain after owner setup and stops it', async () => {
    const spawned: string[][] = []
    class FakeChild extends EventEmitter {
      killed = false
      exitCode: number | null = null
      signalCode: NodeJS.Signals | null = null
      kill(): boolean {
        this.killed = true
        this.exitCode = null
        this.signalCode = 'SIGTERM'
        this.emit('exit', null, 'SIGTERM')
        return true
      }
    }
    const child = new FakeChild()
    const hub: LocalBrainHub = {
      url: 'http://127.0.0.1:3774',
      publicOrigin: 'http://127.0.0.1:3774',
      ownerConfigured: () => true,
      enrollLocalMachine: () => ({ machineId: 'd'.repeat(32), token: `${'d'.repeat(32)}.${Buffer.alloc(32, 3).toString('base64url')}` }),
    }
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const supervisor = superviseLocalBrain({
      hub,
      options: { dataDir: directory(), name: 'vps', allowedWorkspaceRoots: [], allowedScopes: [] },
      execPath: '/usr/bin/node',
      scriptPath: '/opt/crewcode/out/main/hub.js',
      spawnChild: plan => {
        spawned.push(plan.args)
        started()
        return child as unknown as ChildProcess
      },
      log: () => undefined,
      warn: () => undefined,
    })
    await ready
    expect(spawned[0]?.[0]).toBe('/opt/crewcode/out/main/brain.js')
    await supervisor.stop()
    expect(child.killed).toBe(true)
  })
})
