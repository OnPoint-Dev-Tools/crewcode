import { generateKeyPairSync } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  machineCredentialPath,
  normalizeHubUrl,
  parseBrainOptions,
  readMachineCredential,
  writeMachineCredential,
  type MachineCredentialFile,
} from './hub-machine-enrollment'

const directories: string[] = []
afterEach(() => {
  while (directories.length) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'crewcode-brain-test-'))
  directories.push(value)
  return value
}

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
    expect(parseBrainOptions([], 'brain')).toMatchObject({ name: expect.any(String) })
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
