import { encodeMonoWav } from './local-sidecar-voice-transport'
import { createAudioInputWorklet } from './audio-input-worklet'

const TARGET_RATE = 16_000
const SPEECH_THRESHOLD = 0.015
const END_SILENCE_MS = 750
const MAX_CAPTURE_MS = 30_000
const PRE_ROLL_CHUNKS = 4

function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

function concatenate(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const output = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function resample(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === TARGET_RATE) return input
  const ratio = sourceRate / TARGET_RATE
  const output = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < output.length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += input[j]
    output[i] = sum / Math.max(1, end - start)
  }
  return output
}

export class OneShotAudioCapture {
  readonly result: Promise<Uint8Array>

  private media: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: AudioWorkletNode | null = null
  private processorDispose: (() => void) | null = null
  private sink: GainNode | null = null
  private chunks: Float32Array[] = []
  private preRoll: Float32Array[] = []
  private speaking = false
  private silenceMs = 0
  private elapsedMs = 0
  private settled = false
  private resolveResult!: (audio: Uint8Array) => void
  private rejectResult!: (error: Error) => void

  private constructor() {
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
  }

  static async start(): Promise<OneShotAudioCapture> {
    const capture = new OneShotAudioCapture()
    await capture.open()
    return capture
  }

  cancel(): void {
    if (this.settled) return
    this.settled = true
    void this.close()
    this.rejectResult(new Error('Dictation cancelled.'))
  }

  finish(): void {
    if (this.settled) return
    if (this.chunks.length === 0) {
      this.cancelWith(new Error('No speech was detected.'))
      return
    }
    this.settled = true
    const sourceRate = this.context?.sampleRate ?? TARGET_RATE
    const audio = encodeMonoWav(resample(concatenate(this.chunks), sourceRate))
    void this.close()
    this.resolveResult(audio)
  }

  private async open(): Promise<void> {
    try {
      this.media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const context = new AudioContext()
      this.context = context
      this.source = context.createMediaStreamSource(this.media)
      const capture = await createAudioInputWorklet(context, samples => this.consume(samples), 4096)
      this.processor = capture.node
      this.processorDispose = capture.dispose
      this.sink = context.createGain()
      this.sink.gain.value = 0
      this.source.connect(this.processor)
      this.processor.connect(this.sink)
      this.sink.connect(context.destination)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private consume(input: Float32Array): void {
    if (this.settled) return
    const copy = new Float32Array(input)
    const durationMs = (copy.length / (this.context?.sampleRate ?? TARGET_RATE)) * 1_000
    const hasSpeech = rms(copy) >= SPEECH_THRESHOLD
    this.elapsedMs += durationMs

    if (!this.speaking) {
      this.preRoll.push(copy)
      if (this.preRoll.length > PRE_ROLL_CHUNKS) this.preRoll.shift()
      if (hasSpeech) {
        this.speaking = true
        this.chunks = [...this.preRoll]
        this.preRoll = []
      }
    } else {
      this.chunks.push(copy)
      this.silenceMs = hasSpeech ? 0 : this.silenceMs + durationMs
    }

    if ((this.speaking && this.silenceMs >= END_SILENCE_MS) || this.elapsedMs >= MAX_CAPTURE_MS) {
      this.finish()
    }
  }

  private cancelWith(error: Error): void {
    if (this.settled) return
    this.settled = true
    void this.close()
    this.rejectResult(error)
  }

  private async close(): Promise<void> {
    this.processorDispose?.()
    this.source?.disconnect()
    this.sink?.disconnect()
    this.media?.getTracks().forEach(track => track.stop())
    await this.context?.close().catch(() => undefined)
    this.media = null
    this.context = null
    this.source = null
    this.processor = null
    this.processorDispose = null
    this.sink = null
  }
}
