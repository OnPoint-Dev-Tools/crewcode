import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/workspace',
  },
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
}))

import { LocalVoiceService } from './local-voice-service'

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    stdout: EventEmitter & { resume: ReturnType<typeof vi.fn> }
    killed: boolean
    kill: ReturnType<typeof vi.fn>
  }
  child.stderr = new EventEmitter()
  child.stdout = Object.assign(new EventEmitter(), { resume: vi.fn() })
  child.killed = false
  child.kill = vi.fn(() => { child.killed = true })
  return child
}

beforeEach(() => {
  vi.restoreAllMocks()
  spawnMock.mockReset()
})

describe('LocalVoiceService', () => {
  it('starts on loopback and authenticates every sidecar request', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/transcriptions')) {
        return new Response(JSON.stringify({ text: 'Run the tests.' }), { status: 200 })
      }
      if (url.endsWith('/v1/warmup')) {
        return new Response(JSON.stringify({ ok: true, parakeet_loaded: true, kokoro_loaded: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const service = new LocalVoiceService()

    const status = await service.start('/venv/bin/python')
    const result = await service.transcribe(new Uint8Array([1, 2, 3]))

    expect(status).toMatchObject({ running: true, ready: true, endpoint: 'http://127.0.0.1:17841' })
    expect(spawnMock).toHaveBeenCalledWith(
      '/venv/bin/python',
      ['-m', 'crewcode_voice', '--host', '127.0.0.1', '--port', '17841'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    )
    const spawnOptions = spawnMock.mock.calls[0][2]
    expect(spawnOptions.env.CREWCODE_VOICE_TOKEN).toMatch(/^[a-f0-9]{64}$/)
    expect(result).toEqual({ ok: true, text: 'Run the tests.' })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17841/v1/transcriptions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${spawnOptions.env.CREWCODE_VOICE_TOKEN}`,
        }),
      }),
    )
  })

  it('passes normalized speech speed to Kokoro', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => new Response(
      url.endsWith('/v1/warmup/speech')
        ? JSON.stringify({ kokoro_loaded: true })
        : new Uint8Array([82, 73, 70, 70]),
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetcher)
    const service = new LocalVoiceService()
    await service.prewarm('/venv/bin/python', 'auto', 'speech')

    const result = await service.synthesize('Speak faster.', 'am_michael', 1.35)

    expect(result.ok).toBe(true)
    const speechCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/v1/speech'))
    expect(speechCall).toBeDefined()
    expect(JSON.parse(String(speechCall?.[1]?.body))).toEqual({
      text: 'Speak faster.',
      voice: 'am_michael',
      speed: 1.35,
    })
  })

  it('rejects oversized audio before contacting the service', async () => {
    const service = new LocalVoiceService()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)

    const result = await service.transcribe(new Uint8Array(32 * 1024 * 1024 + 1))

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('32 MB') })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('warms only the requested local voice capability', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/warmup/transcription')) {
        return new Response(JSON.stringify({
          ok: true,
          parakeet_loaded: true,
          kokoro_loaded: false,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const service = new LocalVoiceService()

    const status = await service.prewarm('/venv/bin/python', 'auto', 'transcription')

    expect(status).toMatchObject({
      running: true,
      ready: true,
      parakeetLoaded: true,
      kokoroLoaded: false,
    })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:17841/v1/warmup/transcription',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetcher).not.toHaveBeenCalledWith(
      'http://127.0.0.1:17841/v1/warmup',
      expect.anything(),
    )
    expect(spawnMock.mock.calls[0][2].env).toMatchObject({
      CREWCODE_VOICE_DEVICE: 'auto',
      CREWCODE_VOICE_KOKORO_IDLE_SECONDS: '300',
      CREWCODE_VOICE_PARAKEET_IDLE_SECONDS: '900',
    })
  })

  it('passes an explicit CPU device to the managed sidecar', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      url.endsWith('/v1/warmup/transcription')
        ? JSON.stringify({ parakeet_loaded: true, kokoro_loaded: false, resolved_device: 'cpu' })
        : '{}',
      { status: 200 },
    )))
    const service = new LocalVoiceService()

    const status = await service.prewarm('/venv/bin/python', 'cpu', 'transcription')

    expect(spawnMock.mock.calls[0][2].env.CREWCODE_VOICE_DEVICE).toBe('cpu')
    expect(status).toMatchObject({ ready: true, resolvedDevice: 'cpu' })
  })

  it('restarts an empty sidecar after the managed idle recycle exit', async () => {
    const firstChild = fakeChild()
    const secondChild = fakeChild()
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    const fetcher = vi.fn(async (url: string) => new Response(
      url.endsWith('/v1/warmup/transcription')
        ? JSON.stringify({ parakeet_loaded: true, kokoro_loaded: false })
        : '{}',
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetcher)
    const service = new LocalVoiceService()
    await service.prewarm('/venv/bin/python', 'gpu', 'transcription')
    const warmupCallsBeforeRecycle = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/warmup/transcription'),
    ).length

    firstChild.emit('close', 75)

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    expect(spawnMock.mock.calls[1][2].env.CREWCODE_VOICE_DEVICE).toBe('gpu')
    expect(fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/warmup/transcription'),
    )).toHaveLength(warmupCallsBeforeRecycle)
  })

  it('kills the managed child on stop', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      url.endsWith('/v1/warmup')
        ? JSON.stringify({ parakeet_loaded: true, kokoro_loaded: true })
        : '{}',
      { status: 200 },
    )))
    const service = new LocalVoiceService()
    await service.start('')

    service.stop()

    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('includes captured sidecar output when a request loses the process', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/warmup')) {
        return new Response(JSON.stringify({ parakeet_loaded: true, kokoro_loaded: true }), { status: 200 })
      }
      if (url.endsWith('/v1/transcriptions')) throw new TypeError('fetch failed')
      return new Response('{}', { status: 200 })
    }))
    const service = new LocalVoiceService()
    await service.start('')
    child.stderr.emit('data', 'Parakeet worker exited unexpectedly')

    const result = await service.transcribe(new Uint8Array([1]))

    expect(result).toEqual({
      ok: false,
      error: 'fetch failed: Parakeet worker exited unexpectedly',
    })
  })
})
