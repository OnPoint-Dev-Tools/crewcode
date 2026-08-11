import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { join } from 'path'
import {
  normalizeLocalVoiceSpeed,
  type LocalVoiceServiceStatus,
  type LocalVoiceSpeechResult,
  type LocalVoiceTranscriptionResult,
  type LocalVoiceDevice,
  type LocalVoiceWarmupCapability,
} from '../shared/voice-types'

const HOST = '127.0.0.1'
const PORT = 17_841
const ENDPOINT = `http://${HOST}:${PORT}`
const START_TIMEOUT_MS = 30_000
const MAX_AUDIO_BYTES = 32 * 1024 * 1024
const IDLE_RECYCLE_EXIT_CODE = 75

interface LocalVoiceConfiguration {
  pythonPath: string
  device: LocalVoiceDevice
}

function normalizeDevice(device: LocalVoiceDevice | undefined): LocalVoiceDevice {
  return device === 'gpu' || device === 'cpu' ? device : 'auto'
}

function serviceDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'local-voice')
    : join(app.getAppPath(), 'services', 'local-voice')
}

export class LocalVoiceService {
  private child: ChildProcess | null = null
  private token: string | null = null
  private error: string | null = null
  private output = ''
  private starting: Promise<LocalVoiceServiceStatus> | null = null
  private configuration: LocalVoiceConfiguration | null = null

  async start(pythonPath: string, device: LocalVoiceDevice = 'auto'): Promise<LocalVoiceServiceStatus> {
    return this.prewarm(pythonPath, device, 'all')
  }

  async prewarm(
    pythonPath: string,
    device: LocalVoiceDevice,
    capability: LocalVoiceWarmupCapability,
  ): Promise<LocalVoiceServiceStatus> {
    const running = await this.ensureRunning(pythonPath, normalizeDevice(device))
    if (!running.ready) return running
    return this.warmup(capability)
  }

  private async ensureRunning(pythonPath: string, device: LocalVoiceDevice): Promise<LocalVoiceServiceStatus> {
    const requested = { pythonPath: pythonPath.trim(), device }
    if (await this.health()) {
      if (this.configuration?.pythonPath === requested.pythonPath && this.configuration.device === requested.device) {
        return this.runningStatus()
      }
      await this.stopChild(false)
    }
    if (this.starting) return this.starting

    this.starting = this.spawnAndWait(requested)
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async spawnAndWait(configuration: LocalVoiceConfiguration): Promise<LocalVoiceServiceStatus> {
    if (this.child) await this.stopChild(false)

    const executable = configuration.pythonPath || (process.platform === 'win32' ? 'python' : 'python3')
    const token = randomBytes(32).toString('hex')
    this.token = token
    this.error = null
    this.output = ''
    this.configuration = configuration
    const child = spawn(executable, ['-m', 'crewcode_voice', '--host', HOST, '--port', String(PORT)], {
      cwd: serviceDirectory(),
      env: {
        ...process.env,
        CREWCODE_VOICE_TOKEN: token,
        CREWCODE_VOICE_DEVICE: configuration.device,
        CREWCODE_VOICE_KOKORO_IDLE_SECONDS: '300',
        CREWCODE_VOICE_PARAKEET_IDLE_SECONDS: '900',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.on('data', chunk => this.captureOutput(String(chunk)))
    child.stderr.on('data', chunk => {
      this.captureOutput(String(chunk))
    })
    child.on('error', error => {
      this.error = error.message
    })
    child.on('close', code => {
      if (this.child !== child) return
      const restartConfiguration = this.configuration
      this.child = null
      this.token = null
      if (code === IDLE_RECYCLE_EXIT_CODE && restartConfiguration) {
        // The sidecar detected CUDA allocations that survived model deletion;
        // a clean process is the only operation that guarantees their release.
        void this.ensureRunning(restartConfiguration.pythonPath, restartConfiguration.device)
        return
      }
      if (code !== 0) this.error = this.output.trim() || `Local voice service exited with code ${code ?? 'unknown'}`
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.health()) return this.runningStatus()
      if (!this.child) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const detail = this.error ?? 'Local voice service did not become ready within 30 seconds.'
    this.stop()
    return { running: false, ready: false, endpoint: ENDPOINT, error: detail }
  }

  stop(): void {
    this.configuration = null
    void this.stopChild(false)
  }

  private async stopChild(clearConfiguration: boolean): Promise<void> {
    const child = this.child
    this.child = null
    this.token = null
    if (clearConfiguration) this.configuration = null
    if (!child || child.killed) return
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 1_500)
      child.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.kill()
    })
  }

  async status(): Promise<LocalVoiceServiceStatus> {
    const detail = await this.requestJson('/v1/status').catch(() => null) as {
      parakeet_loaded?: boolean
      kokoro_loaded?: boolean
      configured_device?: LocalVoiceDevice
      resolved_device?: 'cuda' | 'cpu' | null
      cuda_reserved_bytes?: number
    } | null
    return {
      running: this.child !== null,
      ready: detail !== null,
      endpoint: ENDPOINT,
      parakeetLoaded: detail?.parakeet_loaded,
      kokoroLoaded: detail?.kokoro_loaded,
      configuredDevice: detail?.configured_device,
      resolvedDevice: detail?.resolved_device ?? undefined,
      cudaReservedBytes: detail?.cuda_reserved_bytes,
      error: detail ? undefined : this.error ?? undefined,
    }
  }

  async transcribe(audio: Uint8Array): Promise<LocalVoiceTranscriptionResult> {
    if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) {
      return { ok: false, error: 'Voice audio must be between 1 byte and 32 MB.' }
    }

    const body = Uint8Array.from(audio).buffer
    let firstFailure: unknown = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.request('/v1/transcriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body,
        })
        const payload = await response.json() as { text?: unknown; detail?: unknown }
        if (!response.ok) return { ok: false, error: this.responseError(payload, response.status) }
        return typeof payload.text === 'string' && payload.text.trim()
          ? { ok: true, text: payload.text.trim() }
          : { ok: false, error: 'Parakeet returned an empty transcription.' }
      } catch (error) {
        firstFailure ??= error
        const failedChild = this.child
        if (attempt === 0 && failedChild) await this.waitForExit(failedChild)
        const configuration = this.configuration
        if (attempt > 0 || this.child || !configuration) {
          return { ok: false, error: this.requestFailure(firstFailure) }
        }

        // CUDA faults terminate the native sidecar and can race with a pending
        // transcription. Preserve the captured WAV and retry it once in a clean
        // process instead of making the user record the utterance again.
        const running = await this.ensureRunning(configuration.pythonPath, configuration.device)
        if (!running.ready) return { ok: false, error: running.error ?? this.requestFailure(firstFailure) }
        const warmed = await this.warmup('transcription')
        if (!warmed.ready) return { ok: false, error: warmed.error ?? this.requestFailure(firstFailure) }
      }
    }

    return { ok: false, error: this.requestFailure(firstFailure) }
  }

  async synthesize(text: string, voice: string, speed = 1): Promise<LocalVoiceSpeechResult> {
    const concise = text.trim()
    if (!concise || concise.length > 4_000) return { ok: false, error: 'Speech text must be between 1 and 4,000 characters.' }
    try {
      const response = await this.request('/v1/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: concise, voice, speed: normalizeLocalVoiceSpeed(speed) }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: unknown }
        return { ok: false, error: this.responseError(payload, response.status) }
      }
      return { ok: true, audio: new Uint8Array(await response.arrayBuffer()) }
    } catch (error) {
      return { ok: false, error: this.requestFailure(error) }
    }
  }

  private async health(): Promise<boolean> {
    return this.request('/v1/health').then(response => response.ok).catch(() => false)
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await this.request(path)
    if (!response.ok) throw new Error(`Local voice service returned HTTP ${response.status}.`)
    return response.json()
  }

  private async warmup(capability: LocalVoiceWarmupCapability): Promise<LocalVoiceServiceStatus> {
    const path = capability === 'all' ? '/v1/warmup' : `/v1/warmup/${capability}`
    try {
      const response = await this.request(path, { method: 'POST' }, 10 * 60_000)
      const payload = await response.json() as {
        parakeet_loaded?: boolean
        kokoro_loaded?: boolean
        configured_device?: LocalVoiceDevice
        resolved_device?: 'cuda' | 'cpu' | null
        cuda_reserved_bytes?: number
        detail?: unknown
      }
      if (!response.ok) {
        return {
          running: this.child !== null,
          ready: false,
          endpoint: ENDPOINT,
          error: this.responseError(payload, response.status),
        }
      }
      return {
        running: this.child !== null,
        ready: capability === 'transcription'
          ? payload.parakeet_loaded === true
          : capability === 'speech'
            ? payload.kokoro_loaded === true
            : payload.parakeet_loaded === true && payload.kokoro_loaded === true,
        endpoint: ENDPOINT,
        parakeetLoaded: payload.parakeet_loaded,
        kokoroLoaded: payload.kokoro_loaded,
        configuredDevice: payload.configured_device,
        resolvedDevice: payload.resolved_device ?? undefined,
        cudaReservedBytes: payload.cuda_reserved_bytes,
      }
    } catch (error) {
      return {
        running: this.child !== null,
        ready: false,
        endpoint: ENDPOINT,
        error: this.requestFailure(error),
      }
    }
  }

  private runningStatus(): LocalVoiceServiceStatus {
    return {
      running: this.child !== null,
      ready: true,
      endpoint: ENDPOINT,
    }
  }

  private request(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<Response> {
    if (!this.token) return Promise.reject(new Error('Local voice service is not running.'))
    return fetch(`${ENDPOINT}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  private async waitForExit(child: ChildProcess): Promise<void> {
    if (this.child !== child) return
    await new Promise<void>(resolve => {
      const finish = (): void => {
        clearTimeout(timeout)
        child.off('close', finish)
        resolve()
      }
      const timeout = setTimeout(finish, 500)
      child.once('close', finish)
    })
  }

  private responseError(payload: { detail?: unknown }, status: number): string {
    return typeof payload.detail === 'string' ? payload.detail : `Local voice service returned HTTP ${status}.`
  }

  private captureOutput(chunk: string): void {
    this.output = `${this.output}${chunk}`.slice(-8_000)
  }

  private requestFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    const detail = this.error ?? this.output.trim()
    return detail ? `${message}: ${detail}` : message
  }
}

export const localVoiceService = new LocalVoiceService()
