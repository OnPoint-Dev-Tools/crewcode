import {
  BaseVoiceTransport,
  VOICE_TOOLS,
  voiceSessionInstructions,
  type VoiceTransportContext,
} from './voice-agent-contract'

interface RealtimeEvent {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  transcript?: string
  delta?: string
  error?: { message?: string }
}

export class OpenAIRealtimeVoiceTransport extends BaseVoiceTransport {
  readonly id = 'openai'
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private media: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private awaitingAgentResult = false

  async start(context: VoiceTransportContext): Promise<void> {
    this.emit({ type: 'phase', phase: 'connecting', status: 'connecting OpenAI voice' })
    const api = window.electronAPI
    if (!api) throw new Error('CrewCode voice API unavailable')
    const instructions = voiceSessionInstructions(context.agentLabel)
    const secret = await api.voiceCreateClientSecret({
      provider: 'openai',
      model: context.model,
      voice: context.voice,
      instructions,
    })
    if (!secret.ok || !secret.value) throw new Error(secret.error ?? 'OpenAI voice is not configured')

    const peer = new RTCPeerConnection()
    this.peer = peer
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.media = media
    const audio = document.createElement('audio')
    this.audio = audio
    audio.autoplay = true
    peer.ontrack = event => {
      audio.srcObject = event.streams[0]
      this.emit({ type: 'phase', phase: 'speaking', status: 'speaking' })
    }
    peer.addTrack(media.getAudioTracks()[0], media)

    const channel = peer.createDataChannel('oai-events')
    this.channel = channel
    channel.addEventListener('open', () => {
      this.send({
        type: 'session.update',
        session: {
          instructions,
          tools: VOICE_TOOLS,
          tool_choice: 'auto',
          turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
        },
      })
      this.emit({ type: 'phase', phase: 'listening', status: `listening · ${context.agentLabel}` })
    })
    channel.addEventListener('message', event => {
      try {
        this.handleEvent(JSON.parse(event.data) as RealtimeEvent)
      } catch {
        this.emit({ type: 'error', message: 'OpenAI realtime returned an invalid event' })
      }
    })
    channel.addEventListener('close', () => this.emit({ type: 'phase', phase: 'idle', status: 'voice off' }))

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret.value}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    })
    if (!response.ok) throw new Error(`OpenAI voice connection failed (HTTP ${response.status})`)
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() })

  }

  async stop(): Promise<void> {
    this.channel?.close()
    this.peer?.close()
    this.media?.getTracks().forEach(track => track.stop())
    if (this.audio) this.audio.srcObject = null
    this.peer = null
    this.channel = null
    this.media = null
    this.audio = null
    this.awaitingAgentResult = false
    this.emit({ type: 'phase', phase: 'idle', status: 'voice off' })
  }

  setInputEnabled(enabled: boolean): void {
    this.media?.getAudioTracks().forEach(track => { track.enabled = enabled })
  }

  interrupt(): void {
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
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(event))
  }

  private handleEvent(event: RealtimeEvent): void {
    if (event.type === 'response.function_call_arguments.done' && event.call_id && event.name) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(event.arguments ?? '{}') as Record<string, unknown> } catch { /* invalid args are rejected by controller */ }
      if (event.name === 'send_prompt_to_agent' || event.name === 'get_agent_status') {
        this.emit({ type: 'tool_call', call: { callId: event.call_id, name: event.name, arguments: args } })
      }
      return
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      this.emit({ type: 'phase', phase: 'listening', status: 'listening' })
    } else if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'response.created') {
      this.emit({ type: 'phase', phase: 'processing', status: 'understanding' })
    } else if (event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') {
      this.emit({ type: 'phase', phase: 'speaking', status: 'speaking' })
    } else if (event.type === 'response.done') {
      if (this.awaitingAgentResult) {
        this.awaitingAgentResult = false
        this.emit({ type: 'result_complete' })
      } else {
        this.emit({ type: 'phase', phase: 'listening', status: 'listening' })
      }
    } else if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
      this.emit({ type: 'transcript', text: event.transcript, final: true })
    } else if (event.type === 'error') {
      this.emit({ type: 'error', message: event.error?.message ?? 'OpenAI realtime error' })
    }
  }
}
