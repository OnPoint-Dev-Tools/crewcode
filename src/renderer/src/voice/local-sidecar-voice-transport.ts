import {
  BaseVoiceTransport,
  type VoiceTransportContext,
} from './voice-agent-contract'
import {
  LOCAL_VOICE_SPEED_DEFAULT,
  normalizeLocalVoiceSpeed,
  type LocalVoiceDevice,
} from '../../../shared/voice-types'
import { getCrewCodeClient } from '../runtime/crewcode-client'
import { createAudioInputWorklet } from './audio-input-worklet'

const TARGET_RATE = 16_000
const SPEECH_THRESHOLD = 0.015
const END_SILENCE_MS = 750
const MAX_UTTERANCE_MS = 30_000
const PRE_ROLL_CHUNKS = 4
const LOCAL_SPEECH_CHUNK_CHARS = 3_900

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

export function encodeMonoWav(samples: Float32Array, sampleRate = TARGET_RATE): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

export function chunkSpokenText(text: string, maxChars = LOCAL_SPEECH_CHUNK_CHARS): string[] {
  const sentences = text.trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []
  const chunks: string[] = []
  let current = ''

  const append = (piece: string): void => {
    const words = piece.trim().split(/\s+/).filter(Boolean)
    for (const word of words) {
      if (word.length > maxChars) {
        if (current) {
          chunks.push(current)
          current = ''
        }
        for (let offset = 0; offset < word.length; offset += maxChars) {
          chunks.push(word.slice(offset, offset + maxChars))
        }
        continue
      }
      const candidate = current ? `${current} ${word}` : word
      if (candidate.length > maxChars) {
        chunks.push(current)
        current = word
      } else {
        current = candidate
      }
    }
  }

  for (const sentence of sentences) append(sentence)
  if (current) chunks.push(current)
  return chunks
}

export class LocalSidecarVoiceTransport extends BaseVoiceTransport {
  readonly id = 'local'
  private media: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: AudioWorkletNode | null = null
  private processorDispose: (() => void) | null = null
  private sink: GainNode | null = null
  private chunks: Float32Array[] = []
  private preRoll: Float32Array[] = []
  private speaking = false
  private processing = false
  private silenceMs = 0
  private utteranceMs = 0
  private callSequence = 0
  private voice = 'am_michael'
  private playback: HTMLAudioElement | null = null
  private playbackUrl: string | null = null
  private playbackDone: ((played: boolean) => void) | null = null
  private playbackSequence = 0
  private pythonPath = ''
  private device: LocalVoiceDevice = 'auto'
  private speechSpeed = LOCAL_VOICE_SPEED_DEFAULT

  async start(context: VoiceTransportContext): Promise<void> {
    const api = getCrewCodeClient()
    this.emit({ type: 'phase', phase: 'connecting', status: 'starting local voice' })
    this.pythonPath = context.pythonPath ?? ''
    this.device = context.localDevice ?? 'auto'
    this.speechSpeed = normalizeLocalVoiceSpeed(context.localSpeechSpeed)
    const status = await api.voiceLocalPrewarm({
      pythonPath: this.pythonPath,
      device: this.device,
    }, 'transcription')
    if (!status.ready) throw new Error(status.error ?? 'Local voice service is unavailable')
    this.voice = context.voice || 'am_michael'

    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.media = media
    const audioContext = new AudioContext()
    this.context = audioContext
    const source = audioContext.createMediaStreamSource(media)
    this.source = source
    const capture = await createAudioInputWorklet(audioContext, samples => this.consume(samples), 4096)
    const processor = capture.node
    this.processor = processor
    this.processorDispose = capture.dispose
    const sink = audioContext.createGain()
    sink.gain.value = 0
    this.sink = sink
    source.connect(processor)
    processor.connect(sink)
    sink.connect(audioContext.destination)
    this.emit({ type: 'phase', phase: 'listening', status: `listening · ${context.agentLabel}` })
  }

  async stop(): Promise<void> {
    this.stopPlayback()
    this.processorDispose?.()
    this.source?.disconnect()
    this.sink?.disconnect()
    this.media?.getTracks().forEach(track => track.stop())
    await this.context?.close()
    this.media = null
    this.context = null
    this.source = null
    this.processor = null
    this.processorDispose = null
    this.sink = null
    this.resetCapture()
    this.emit({ type: 'phase', phase: 'idle', status: 'voice off' })
  }

  setInputEnabled(enabled: boolean): void {
    this.media?.getAudioTracks().forEach(track => { track.enabled = enabled })
    if (!enabled) this.resetCapture()
  }

  interrupt(): void {
    this.stopPlayback()
    this.emit({ type: 'phase', phase: 'listening', status: 'listening' })
  }

  sendToolResult(_callId: string, result: Record<string, unknown>): void {
    if (result.status === 'started') {
      // Dictation never needs TTS; warm Kokoro only after the orb has actually
      // handed work to a coding agent, overlapping its load with that turn.
      void getCrewCodeClient().voiceLocalPrewarm({
        pythonPath: this.pythonPath,
        device: this.device,
      }, 'speech').catch(() => {})
    }
    if (result.status === 'rejected' && typeof result.error === 'string') {
      this.sendAgentResult(result.error)
    }
  }

  sendAgentResult(spokenText: string): void {
    void this.speak(spokenText)
  }

  private consume(input: Float32Array): void {
    if (this.processing || this.playback) return
    const copy = new Float32Array(input)
    const durationMs = (copy.length / (this.context?.sampleRate ?? TARGET_RATE)) * 1_000
    const hasSpeech = rms(copy) >= SPEECH_THRESHOLD

    if (!this.speaking) {
      this.preRoll.push(copy)
      if (this.preRoll.length > PRE_ROLL_CHUNKS) this.preRoll.shift()
      if (!hasSpeech) return
      this.speaking = true
      this.chunks = [...this.preRoll]
      this.preRoll = []
      this.silenceMs = 0
      this.utteranceMs = this.chunks.length * durationMs
    } else {
      this.chunks.push(copy)
      this.utteranceMs += durationMs
    }

    this.silenceMs = hasSpeech ? 0 : this.silenceMs + durationMs
    if (this.silenceMs >= END_SILENCE_MS || this.utteranceMs >= MAX_UTTERANCE_MS) {
      void this.finishUtterance()
    }
  }

  private async finishUtterance(): Promise<void> {
    if (this.processing || this.chunks.length === 0) return
    this.processing = true
    const chunks = this.chunks
    this.resetCapture()
    this.emit({ type: 'phase', phase: 'processing', status: 'transcribing locally' })
    try {
      const sourceRate = this.context?.sampleRate ?? TARGET_RATE
      const wav = encodeMonoWav(resample(concatenate(chunks), sourceRate))
      const result = await getCrewCodeClient().voiceLocalTranscribe(wav)
      if (!result?.ok || !result.text) throw new Error(result?.error ?? 'Parakeet transcription failed')
      this.emit({ type: 'transcript', text: result.text, final: true })
      this.emit({
        type: 'tool_call',
        call: {
          callId: `local-${++this.callSequence}`,
          name: 'send_prompt_to_agent',
          arguments: { text: result.text },
        },
      })
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.processing = false
    }
  }

  private async speak(text: string): Promise<void> {
    this.stopPlayback()
    const sequence = this.playbackSequence
    const chunks = chunkSpokenText(text)
    for (const chunk of chunks) {
      if (sequence !== this.playbackSequence) return
      this.emit({ type: 'phase', phase: 'processing', status: 'generating local speech' })
      const result = await getCrewCodeClient().voiceLocalSynthesize(chunk, this.voice, this.speechSpeed)
      if (sequence !== this.playbackSequence) return
      if (!result?.ok || !result.audio) {
        this.emit({ type: 'error', message: result?.error ?? 'Kokoro speech failed' })
        return
      }
      this.emit({ type: 'phase', phase: 'speaking', status: 'speaking · Michael' })
      const played = await this.playAudioChunk(result.audio)
      if (!played || sequence !== this.playbackSequence) return
    }
    // One click owns exactly one coding turn; release the voice session only
    // after every prose chunk has played.
    this.emit({ type: 'result_complete' })
  }

  private playAudioChunk(result: Uint8Array): Promise<boolean> {
    const bytes = new Uint8Array(result)
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: 'audio/wav' }))
    const audio = new Audio(url)
    this.playback = audio
    this.playbackUrl = url
    return new Promise(resolve => {
      this.playbackDone = resolve
      const fail = (): void => {
        if (this.playback !== audio) return
        this.emit({ type: 'error', message: 'Could not play Kokoro speech.' })
        this.finishPlaybackChunk(false)
      }
      audio.onended = () => {
        if (this.playback === audio) this.finishPlaybackChunk(true)
      }
      audio.onerror = fail
      void audio.play().catch(fail)
    })
  }

  private finishPlaybackChunk(played: boolean): void {
    const done = this.playbackDone
    this.playbackDone = null
    this.playback?.pause()
    this.playback = null
    if (this.playbackUrl) URL.revokeObjectURL(this.playbackUrl)
    this.playbackUrl = null
    done?.(played)
  }

  private stopPlayback(): void {
    this.playbackSequence += 1
    this.finishPlaybackChunk(false)
  }

  private resetCapture(): void {
    this.chunks = []
    this.preRoll = []
    this.speaking = false
    this.silenceMs = 0
    this.utteranceMs = 0
  }
}
