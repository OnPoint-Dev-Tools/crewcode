import { generateKeyPairSync } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HubDeviceEnrollmentIssuer,
  enrollMachineByApproval,
  machineCredentialPath,
  normalizeHubUrl,
  parseBrainOptions,
  readMachineCredential,
  writeMachineCredential,
  type MachineCredentialFile,
} from './hub-machine-enrollment'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  while (directories.length) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'crewcode-brain-test-'))
  directories.push(value)
  return value
}

describe('phone-approved device enrollment issuer', () => {
  it('uses a short display code but keeps authority in a one-time 256-bit polling secret', () => {
    let now = 1_000
    const issuer = new HubDeviceEnrollmentIssuer(() => now)
    const keys = generateKeyPairSync('ed25519')
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    const request = issuer.request({ publicKey, name: 'Cortex', platform: 'linux', version: 'test' })
    expect(request.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(request.requestToken).not.toContain(request.userCode)
    expect(Buffer.from(request.requestToken.split('.')[1], 'base64url')).toHaveLength(32)
    expect(issuer.list()[0]).toMatchObject({ id: request.requestId, userCode: request.userCode, name: 'Cortex' })
    expect(issuer.poll(request.requestToken)).toEqual({ status: 'pending' })
    expect(issuer.approve(request.requestId, { machineId: 'a'.repeat(32), token: 'machine.secret' })).toBe(true)
    expect(issuer.poll(request.requestToken)).toEqual({ status: 'approved', machineId: 'a'.repeat(32), token: 'machine.secret' })
    expect(issuer.poll(request.requestToken)).toBeNull()

    const expired = issuer.request({ publicKey, name: 'Old', platform: null, version: null })
    now = expired.expiresAt
    expect(issuer.poll(expired.requestToken)).toBeNull()
  })
})

describe('Hub machine client security', () => {
  it('accepts HTTPS and loopback HTTP Hub origins only', () => {
    expect(normalizeHubUrl('https://hub.example/')).toBe('https://hub.example')
    expect(normalizeHubUrl('http://localhost:3774')).toBe('http://localhost:3774')
    expect(() => normalizeHubUrl('http://hub.example')).toThrow('HTTPS origin')
    expect(() => normalizeHubUrl('https://hub.example/path')).toThrow('HTTPS origin')
    expect(() => normalizeHubUrl('https://user:secret@hub.example')).toThrow('HTTPS origin')
  })

  it('parses enrollment and brain options without requiring secrets in argv', () => {
    expect(parseBrainOptions(['--hub', 'https://hub.example', '--name', 'cortex'], 'enroll', '/tmp')).toMatchObject({
      hubOrigin: 'https://hub.example', name: 'cortex', token: undefined,
    })
    expect(() => parseBrainOptions([], 'enroll')).toThrow('requires --hub')
    expect(parseBrainOptions([], 'brain')).toMatchObject({ name: expect.any(String), allowedScopes: [], allowedWorkspaceRoots: [] })
    expect(parseBrainOptions(['--workspace-root', '.', '--allow-scope', 'workspace:read', '--allow-scope', 'agent'], 'brain', '/tmp')).toMatchObject({
      allowedWorkspaceRoots: ['/tmp'], allowedScopes: ['workspace:read', 'agent'],
    })
    expect(() => parseBrainOptions(['--allow-scope', 'everything'], 'brain')).toThrow('invalid Brain scope')
  })

  it('polls privately until phone approval and persists the PC-generated identity', async () => {
    const dataDir = directory()
    const machineId = 'b'.repeat(32)
    const machineToken = `${machineId}.${Buffer.alloc(32, 9).toString('base64url')}`
    let polls = 0
    let requestedPublicKey = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/request')) {
        requestedPublicKey = (JSON.parse(String(init.body)) as { publicKey: string }).publicKey
        return new Response(JSON.stringify({ requestToken: `request.${Buffer.alloc(32, 3).toString('base64url')}`, userCode: 'ABCD-2345', expiresAt: 10_000 }), { status: 201 })
      }
      polls += 1
      return new Response(JSON.stringify(polls === 1 ? { status: 'pending' } : { status: 'approved', machineId, token: machineToken }), { status: polls === 1 ? 202 : 200 })
    }))
    let now = 1_000
    const pending = vi.fn()
    const credential = await enrollMachineByApproval({
      dataDir, hubOrigin: 'https://hub.example', name: 'Cortex', allowedWorkspaceRoots: [], allowedScopes: [],
    }, { now: () => now, sleep: async ms => { now += ms }, onPending: pending })

    expect(pending).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCD-2345', verificationUrl: 'https://hub.example' }))
    expect(credential).toMatchObject({ machineId, token: machineToken, publicKey: requestedPublicKey })
    expect(readMachineCredential(machineCredentialPath(dataDir))).toEqual(credential)
  })

  it('writes and validates an owner-only machine credential file', () => {
    const dataDir = directory()
    const path = machineCredentialPath(dataDir)
    const keys = generateKeyPairSync('ed25519')
    const machineId = 'a'.repeat(32)
    const credential: MachineCredentialFile = {
      version: 1,
      hubOrigin: 'https://hub.example',
      machineId,
      token: `${machineId}.${Buffer.alloc(32, 7).toString('base64url')}`,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      enrolledAt: 1_000,
    }
    writeMachineCredential(path, credential)
    expect(readMachineCredential(path)).toEqual(credential)
    expect(() => writeMachineCredential(path, credential)).toThrow()
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)

    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain(credential.token)
    writeFileSync(path, JSON.stringify({ ...credential, privateKey: 'corrupt' }))
    expect(() => readMachineCredential(path)).toThrow('invalid machine credential')
    expect(() => readMachineCredential(join(dataDir, 'missing.json'))).toThrow('could not read machine credential')
  })
})
