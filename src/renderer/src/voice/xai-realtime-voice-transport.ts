import {
  BaseVoiceTransport,
  VOICE_TOOLS,
  voiceSessionInstructions,
  type VoiceTransportContext,
} from './voice-agent-contract'
import { createAudioInputWorklet } from './audio-input-worklet'

const AUDIO_RATE = 24_000

interface XaiEvent {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  transcript?: string
  error?: { message?: string }
}

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]))
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output.buffer
}

export class XaiRealtimeVoiceTransport extends BaseVoiceTransport {
  readonly id = 'xai'
  private socket: WebSocket | null = null
  private media: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private processor: AudioWorkletNode | null = null
  private processorDispose: (() => void) | null = null
  private inputSource: MediaStreamAudioSourceNode | null = null
  private inputSink: GainNode | null = null
  private scheduledAt = 0
  private playing = new Set<AudioBufferSourceNode>()
  private awaitingAgentResult = false
  private agentResultResponseDone = false

  async start(context: VoiceTransportContext): Promise<void> {
    this.emit({ type: 'phase', phase: 'connecting', status: 'connecting xAI voice' })
    const api = window.electronAPI
    if (!api) throw new Error('CrewCode voice API unavailable')
    const instructions = voiceSessionInstructions(context.agentLabel)
    const secret = await api.voiceCreateClientSecret({
      provider: 'xai',
      model: context.model,
      voice: context.voice,
      instructions,
    })
    if (!secret.ok || !secret.value) throw new Error(secret.error ?? 'xAI voice is not configured')

    const socket = new WebSocket(
      `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(context.model)}`,
      [`xai-client-secret.${secret.value}`],
    )
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('message', event => { void this.handleMessage(event.data) })
    socket.addEventListener('close', () => this.emit({ type: 'phase', phase: 'idle', status: 'voice off' }))
    socket.addEventListener('error', () => this.emit({ type: 'error', message: 'xAI realtime connection failed' }))

    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.media = media
    const audioContext = new AudioContext({ sampleRate: AUDIO_RATE })
    this.audioContext = audioContext
    const inputSource = audioContext.createMediaStreamSource(media)
    this.inputSource = inputSource
    const capture = await createAudioInputWorklet(audioContext, samples => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(floatToPcm16(samples))
    }, 2048)
    const processor = capture.node
    this.processor = processor
    this.processorDispose = capture.dispose
    const inputSink = audioContext.createGain()
    inputSink.gain.value = 0
    this.inputSink = inputSink
    inputSource.connect(processor)
    processor.connect(inputSink)
    inputSink.connect(audioContext.destination)

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('xAI realtime connection failed')), { once: true })
    })
    socket.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: context.voice,
        instructions,
        tools: VOICE_TOOLS,
        tool_choice: 'auto',
        turn_detection: { type: 'server_vad' },
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: AUDIO_RATE },
            transport: 'binary',
            transcription: { model: 'grok-transcribe' },
          },
          output: { format: { type: 'audio/pcm', rate: AUDIO_RATE }, transport: 'binary' },
        },
      },
    }))

    this.scheduledAt = audioContext.currentTime
    this.emit({ type: 'phase', phase: 'listening', status: `listening · ${context.agentLabel}` })
  }

  async stop(): Promise<void> {
    this.playing.forEach(source => { try { source.stop() } catch { /* already stopped */ } })
    this.playing.clear()
    this.processorDispose?.()
    this.inputSource?.disconnect()
    this.inputSink?.disconnect()
    this.media?.getTracks().forEach(track => track.stop())
    this.socket?.close()
    await this.audioContext?.close()
    this.socket = null
    this.media = null
    this.audioContext = null
    this.processor = null
    this.processorDispose = null
    this.inputSource = null
    this.inputSink = null
    this.awaitingAgentResult = false
    this.agentResultResponseDone = false
    this.emit({ type: 'phase', phase: 'idle', status: 'voice off' })
  }

  setInputEnabled(enabled: boolean): void {
    this.media?.getAudioTracks().forEach(track => { track.enabled = enabled })
  }

  interrupt(): void {
    this.playing.forEach(source => { try { source.stop() } catch { /* already stopped */ } })
    this.playing.clear()
    this.send({ type: 'response.cancel' })
    this.emit({ type: 'phase', phase: 'listening', status: 'listening' })
  }

  sendToolResult(callId: string, result: Record<string, unknown>): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    })
    this.send({ type: 'response.create' })
  }

  sendAgentResult(spokenText: string): void {
    this.awaitingAgentResult = true
    this.agentResultResponseDone = false
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: `The coding agent finished. Read this complete sanitized prose naturally, in order, without summarizing or omitting sentences: ${spokenText}`,
        }],
      },
    })
    this.send({ type: 'response.create' })
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event))
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (data instanceof ArrayBuffer) {
      this.playPcm(data)
      return
    }
    const raw = typeof data === 'string' ? data : data instanceof Blob ? await data.text() : ''
    if (!raw) return
    let event: XaiEvent
    try {
      event = JSON.parse(raw) as XaiEvent
    } catch {
      this.emit({ type: 'error', message: 'xAI realtime returned an invalid event' })
      return
    }
    if (event.type === 'response.function_call_arguments.done' && event.call_id && event.name) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(event.arguments ?? '{}') as Record<string, unknown> } catch { /* rejected by controller */ }
      if (event.name === 'send_prompt_to_agent' || event.name === 'get_agent_status') {
        this.emit({ type: 'tool_call', call: { callId: event.call_id, name: event.name, arguments: args } })
      }
      return
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      this.interrupt()
    } else if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'response.created') {
      this.emit({ type: 'phase', phase: 'processing', status: 'understanding' })
    } else if (event.type === 'response.done') {
      if (this.awaitingAgentResult) {
        this.agentResultResponseDone = true
        this.completeAgentResultWhenPlaybackEnds()
      } else {
        this.emit({ type: 'phase', phase: 'listening', status: 'listening' })
      }
    } else if (
      (event.type === 'conversation.item.input_audio_transcription.completed'
        || event.type === 'conversation.item.input_audio_transcription.updated')
      && event.transcript
    ) {
      this.emit({ type: 'transcript', text: event.transcript, final: event.type.endsWith('.completed') })
    } else if (event.type === 'error') {
      this.emit({ type: 'error', message: event.error?.message ?? 'xAI realtime error' })
    }
  }

  private playPcm(bytes: ArrayBuffer): void {
    const context = this.audioContext
    if (!context) return
    const pcm = new Int16Array(bytes)
    const buffer = context.createBuffer(1, pcm.length, AUDIO_RATE)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 0x8000
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const startAt = Math.max(context.currentTime, this.scheduledAt)
    source.start(startAt)
    this.scheduledAt = startAt + buffer.duration
    this.playing.add(source)
    source.onended = () => {
      this.playing.delete(source)
      this.completeAgentResultWhenPlaybackEnds()
    }
    this.emit({ type: 'phase', phase: 'speaking', status: 'speaking' })
  }

  private completeAgentResultWhenPlaybackEnds(): void {
    if (!this.awaitingAgentResult || !this.agentResultResponseDone || this.playing.size > 0) return
    this.awaitingAgentResult = false
    this.agentResultResponseDone = false
    this.emit({ type: 'result_complete' })
  }
}
