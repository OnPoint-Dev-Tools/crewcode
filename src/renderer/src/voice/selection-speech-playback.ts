import { useSyncExternalStore } from 'react'
import type { VoiceSpeechRequest } from '../../../shared/voice-types'
import { getCrewCodeClient } from '../runtime/crewcode-client'

export const MAX_SELECTION_SPEECH_CHARS = 4_000

export interface SelectionSpeechState {
  phase: 'idle' | 'loading' | 'playing'
  text: string
}

const IDLE_STATE: SelectionSpeechState = { phase: 'idle', text: '' }
let activeAudio: HTMLAudioElement | null = null
let activeUrl: string | null = null
let requestSequence = 0
let state = IDLE_STATE
const listeners = new Set<() => void>()

function setState(next: SelectionSpeechState): void {
  state = next
  for (const listener of listeners) listener()
}

export function subscribeSelectionSpeech(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSelectionSpeechState(): SelectionSpeechState {
  return state
}

export function useSelectionSpeechState(): SelectionSpeechState {
  return useSyncExternalStore(subscribeSelectionSpeech, getSelectionSpeechState, getSelectionSpeechState)
}

export function stopSelectionSpeech(): void {
  requestSequence += 1
  activeAudio?.pause()
  activeAudio = null
  if (activeUrl) URL.revokeObjectURL(activeUrl)
  activeUrl = null
  setState(IDLE_STATE)
}

export async function playSelectionSpeech(request: VoiceSpeechRequest): Promise<string | null> {
  stopSelectionSpeech()
  const sequence = requestSequence
  setState({ phase: 'loading', text: request.text })

  let result
  try {
    result = await getCrewCodeClient().voiceSynthesize(request)
  } catch (error) {
    if (sequence === requestSequence) setState(IDLE_STATE)
    return error instanceof Error ? error.message : 'Speech synthesis failed.'
  }
  if (sequence !== requestSequence) return null
  if (!result?.ok || !result.audio) {
    setState(IDLE_STATE)
    return result?.error ?? 'Speech synthesis failed.'
  }

  const bytes = new Uint8Array(result.audio)
  const url = URL.createObjectURL(new Blob([bytes.buffer], {
    type: result.contentType || 'audio/wav',
  }))
  const audio = new Audio(url)
  activeAudio = audio
  activeUrl = url
  const release = (): void => {
    if (activeAudio !== audio) return
    activeAudio = null
    if (activeUrl === url) {
      URL.revokeObjectURL(url)
      activeUrl = null
    }
    setState(IDLE_STATE)
  }
  audio.onended = release
  audio.onerror = release
  try {
    await audio.play()
    if (sequence === requestSequence && activeAudio === audio) {
      setState({ phase: 'playing', text: request.text })
    }
    return null
  } catch (error) {
    release()
    return error instanceof Error ? error.message : 'Could not play speech audio.'
  }
}
