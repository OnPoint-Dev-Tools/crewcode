export const NOTIFICATION_SOUND_IDS = ['system', 'bell', 'ding', 'knock', 'none'] as const

export type NotificationSoundId = (typeof NOTIFICATION_SOUND_IDS)[number]

export function normalizeNotificationSound(value: unknown): NotificationSoundId {
  return typeof value === 'string' && (NOTIFICATION_SOUND_IDS as readonly string[]).includes(value)
    ? value as NotificationSoundId
    : 'system'
}

export function usesNativeNotificationSound(sound: NotificationSoundId): boolean {
  return sound === 'system'
}

interface Tone {
  frequency: number
  offset: number
  duration: number
  gain: number
  type: OscillatorType
}

const CUSTOM_TONES: Record<Exclude<NotificationSoundId, 'system' | 'none'>, Tone[]> = {
  bell: [
    { frequency: 880, offset: 0, duration: 1.1, gain: 0.16, type: 'sine' },
    { frequency: 1760, offset: 0, duration: 0.72, gain: 0.06, type: 'sine' },
  ],
  ding: [
    { frequency: 1046.5, offset: 0, duration: 0.22, gain: 0.14, type: 'sine' },
    { frequency: 1318.5, offset: 0.16, duration: 0.38, gain: 0.14, type: 'sine' },
  ],
  knock: [
    { frequency: 150, offset: 0, duration: 0.09, gain: 0.2, type: 'triangle' },
    { frequency: 118, offset: 0.14, duration: 0.1, gain: 0.2, type: 'triangle' },
  ],
}

let audioContext: AudioContext | null = null

function contextForPlayback(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return null
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextClass()
  return audioContext
}

function scheduleTone(context: AudioContext, start: number, tone: Tone): void {
  const oscillator = context.createOscillator()
  const envelope = context.createGain()
  const toneStart = start + tone.offset
  const toneEnd = toneStart + tone.duration

  oscillator.type = tone.type
  oscillator.frequency.setValueAtTime(tone.frequency, toneStart)
  envelope.gain.setValueAtTime(0.0001, toneStart)
  envelope.gain.exponentialRampToValueAtTime(tone.gain, toneStart + 0.008)
  envelope.gain.exponentialRampToValueAtTime(0.0001, toneEnd)
  oscillator.connect(envelope)
  envelope.connect(context.destination)
  oscillator.start(toneStart)
  oscillator.stop(toneEnd + 0.02)
}

export function playNotificationSound(sound: NotificationSoundId): void {
  if (sound === 'system' || sound === 'none') return
  const context = contextForPlayback()
  if (!context) return

  const schedule = () => {
    const start = context.currentTime + 0.015
    for (const tone of CUSTOM_TONES[sound]) scheduleTone(context, start, tone)
  }

  if (context.state === 'suspended') {
    void context.resume().then(schedule).catch(() => { /* audio unavailable */ })
  } else {
    schedule()
  }
}
