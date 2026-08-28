import { spawn, type ChildProcess } from 'child_process'
import { basename, dirname, join } from 'path'
import { platform } from 'os'
import type { BrainAccessScope } from '../shared/hub-relay-types'
import {
  createMachineIdentity,
  loadMachineCredentialIfPresent,
  machineCredentialPath,
  normalizeHubUrl,
  writeMachineCredential,
  type MachineCredentialFile,
} from './hub-machine-enrollment'

export const LOCAL_BRAIN_OWNER_POLL_MS = 1_000
export const LOCAL_BRAIN_STOP_TIMEOUT_MS = 2_000
export const LOCAL_BRAIN_RESPAWN_MS = 5_000

export interface LocalBrainHub {
  url: string
  publicOrigin: string
  ownerConfigured: () => boolean
  enrollLocalMachine: (input: {
    publicKey: string
    name: string
    platform: string | null
    version: string | null
  }) => { machineId: string; token: string }
}

export interface LocalBrainCliOptions {
  dataDir: string
  name: string
  allowedWorkspaceRoots: string[]
  allowedScopes: BrainAccessScope[]
}

export function sameHubOrigin(left: string, right: string): boolean {
  const a = normalizeHubUrl(left)
  const b = normalizeHubUrl(right)
  if (a === b) return true
  const loopbackA = loopbackOriginKey(a)
  const loopbackB = loopbackOriginKey(b)
  return loopbackA !== null && loopbackA === loopbackB
}

function loopbackOriginKey(origin: string): string | null {
  const url = new URL(origin)
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '::1') return null
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${url.protocol}//loopback:${port}`
}

export function credentialTargetsHub(credential: MachineCredentialFile, hub: Pick<LocalBrainHub, 'url' | 'publicOrigin'>): boolean {
  return sameHubOrigin(credential.hubOrigin, hub.url) || sameHubOrigin(credential.hubOrigin, hub.publicOrigin)
}

export function localBrainSpawnPlan(input: {
  execPath: string
  scriptPath?: string
  brainArgv: string[]
}): { execPath: string; args: string[] } {
  const script = input.scriptPath ?? ''
  const base = basename(script)
  if (base === 'crewcode-server.mjs' || base === 'crewcode-server.js') {
    return { execPath: input.execPath, args: [script, 'brain', ...input.brainArgv] }
  }
  if (base === 'hub.js' || base === 'hub.ts') {
    return { execPath: input.execPath, args: [join(dirname(script), base.replace(/^hub\./, 'brain.')), ...input.brainArgv] }
  }
  return { execPath: input.execPath, args: ['brain', ...input.brainArgv] }
}

export function localBrainArgv(options: LocalBrainCliOptions): string[] {
  const args = ['--data-dir', options.dataDir]
  for (const root of options.allowedWorkspaceRoots) args.push('--workspace-root', root)
  for (const scope of options.allowedScopes) args.push('--allow-scope', scope)
  return args
}

function abortError(): Error {
  return new Error('local Brain supervisor stopped')
}

export function sleepOrAbort(ms: number, signal?: AbortSignal, sleep: (ms: number) => Promise<void> = delay => new Promise(resolve => setTimeout(resolve, delay))): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void sleep(ms).then(() => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(abortError())
      else resolve()
    }, error => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

export async function waitForHubOwner(hub: Pick<LocalBrainHub, 'ownerConfigured'>, controls: {
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  onWaiting?: () => void
} = {}): Promise<void> {
  if (hub.ownerConfigured()) return
  controls.onWaiting?.()
  const sleep = controls.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  while (!hub.ownerConfigured()) {
    await sleepOrAbort(LOCAL_BRAIN_OWNER_POLL_MS, controls.signal, sleep)
  }
}

export function ensureLocalBrainEnrollment(hub: LocalBrainHub, options: Pick<LocalBrainCliOptions, 'dataDir' | 'name'>, now = Date.now): { credential: MachineCredentialFile; created: boolean } {
  const path = machineCredentialPath(options.dataDir)
  const existing = loadMachineCredentialIfPresent(path)
  if (existing) {
    if (!credentialTargetsHub(existing, hub)) {
      throw new Error(`local Brain credential at ${path} is enrolled with ${existing.hubOrigin}, not this Hub (${hub.publicOrigin}). Revoke that machine, then move or remove the credential before --local-brain can enroll here.`)
    }
    return { credential: existing, created: false }
  }
  const identity = createMachineIdentity()
  const enrolled = hub.enrollLocalMachine({
    publicKey: identity.publicKey,
    name: options.name,
    platform: platform(),
    version: process.env.npm_package_version ?? null,
  })
  const credential: MachineCredentialFile = {
    version: 1,
    hubOrigin: normalizeHubUrl(hub.url),
    machineId: enrolled.machineId,
    token: enrolled.token,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    enrolledAt: now(),
  }
  writeMachineCredential(path, credential)
  return { credential, created: true }
}

export function stopChildProcess(child: ChildProcess | null, timeoutMs = LOCAL_BRAIN_STOP_TIMEOUT_MS): Promise<void> {
  if (!child || child.killed || child.exitCode !== null || child.signalCode) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolve()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill('SIGTERM') } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

export function superviseLocalBrain(input: {
  hub: LocalBrainHub
  options: LocalBrainCliOptions
  execPath?: string
  scriptPath?: string
  spawnChild?: (plan: { execPath: string; args: string[] }) => ChildProcess
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  warn?: (message: string) => void
}): { stop: () => Promise<void> } {
  const abort = new AbortController()
  const log = input.log ?? (message => console.log(message))
  const warn = input.warn ?? (message => console.warn(message))
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  let child: ChildProcess | null = null
  const spawnChild = input.spawnChild ?? (plan => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    return spawn(plan.execPath, plan.args, { stdio: ['ignore', 'inherit', 'inherit'], env, windowsHide: true })
  })

  const run = (async () => {
    await waitForHubOwner(input.hub, {
      signal: abort.signal,
      sleep,
      onWaiting: () => log('Waiting for the Hub owner passkey before enrolling this host as a local Brain.'),
    })
    if (abort.signal.aborted) return
    const { credential, created } = ensureLocalBrainEnrollment(input.hub, input.options)
    log(created
      ? `Enrolled this Hub host as machine ${credential.machineId}.`
      : `Reusing local Brain credential for ${credential.hubOrigin}.`)
    if (input.options.allowedScopes.length === 0) {
      warn('Local Brain grants: none. Phone users can see this machine, but privileged RPC stays denied until you pass --workspace-root and --allow-scope.')
    }
    const plan = localBrainSpawnPlan({
      execPath: input.execPath ?? process.execPath,
      scriptPath: input.scriptPath ?? process.argv[1],
      brainArgv: localBrainArgv(input.options),
    })
    while (!abort.signal.aborted) {
      child = spawnChild(plan)
      log(`Local Brain process started (${plan.execPath} ${plan.args.join(' ')}).`)
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child?.once('error', error => {
          warn(`Local Brain process failed to start: ${error.message}`)
          resolve({ code: 1, signal: null })
        })
        child?.once('exit', (code, signal) => resolve({ code, signal }))
      })
      child = null
      if (abort.signal.aborted) return
      if (exit.code === 0 && !exit.signal) {
        log('Local Brain process exited. Not restarting.')
        return
      }
      warn(`Local Brain process exited (${exit.signal ?? exit.code}). Restarting in ${LOCAL_BRAIN_RESPAWN_MS / 1000}s.`)
      await sleepOrAbort(LOCAL_BRAIN_RESPAWN_MS, abort.signal, sleep)
    }
  })().catch(error => {
    if (!abort.signal.aborted) warn(`Local Brain supervisor failed: ${(error as Error).message}`)
  })

  return {
    stop: async () => {
      abort.abort()
      await stopChildProcess(child)
      await run
    },
  }
}


