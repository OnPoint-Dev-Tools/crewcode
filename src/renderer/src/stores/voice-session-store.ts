import { create } from 'zustand'
import type { VoiceSessionPhase } from '../../../shared/voice-types'

export interface VoiceSessionState {
  activeScopeId: string | null
  presenterScopeId: string | null
  ownerKind: 'voice' | 'dictation' | null
  phase: VoiceSessionPhase
  status: string
  transcript: string
  error: string | null
}

export const useVoiceSessionStore = create<VoiceSessionState>(() => ({
  activeScopeId: null,
  presenterScopeId: null,
  ownerKind: null,
  phase: 'idle',
  status: 'voice off',
  transcript: '',
  error: null,
}))

export function isVoiceSessionPresentedInScope(state: VoiceSessionState, scopeId: string): boolean {
  return state.ownerKind === 'voice'
    && state.activeScopeId === scopeId
    && state.presenterScopeId === scopeId
}

export function isBackgroundVoicePlayback(state: VoiceSessionState): boolean {
  return state.ownerKind === 'voice'
    && state.phase === 'speaking'
    && state.activeScopeId !== null
    && state.presenterScopeId !== state.activeScopeId
}

const setState = useVoiceSessionStore.setState

export const voiceSession = {
  claim(scopeId: string, ownerKind: 'voice' | 'dictation' = 'voice'): void {
    setState({
      activeScopeId: scopeId,
      presenterScopeId: ownerKind === 'voice' ? scopeId : null,
      ownerKind,
      phase: 'connecting',
      status: 'connecting',
      transcript: '',
      error: null,
    })
  },

  attachPresenter(scopeId: string): void {
    setState(state => state.ownerKind === 'voice' && state.activeScopeId !== null && (
      state.presenterScopeId === null || state.activeScopeId === scopeId
    ) ? { presenterScopeId: scopeId } : state)
  },

  detachPresenter(scopeId: string): void {
    setState(state => state.presenterScopeId === scopeId ? { presenterScopeId: null } : state)
  },

  setPhase(scopeId: string, phase: VoiceSessionPhase, status: string, ownerKind: 'voice' | 'dictation' = 'voice'): void {
    setState(state => state.activeScopeId === scopeId && state.ownerKind === ownerKind
      ? { phase, status, error: phase === 'error' ? state.error : null }
      : state)
  },

  setTranscript(scopeId: string, transcript: string, ownerKind: 'voice' | 'dictation' = 'voice'): void {
    setState(state => state.activeScopeId === scopeId && state.ownerKind === ownerKind ? { transcript } : state)
  },

  requestConfirmation(scopeId: string, transcript: string): void {
    setState(state => state.activeScopeId === scopeId && state.ownerKind === 'voice'
      ? { phase: 'confirming', status: 'Review before sending', transcript, error: null }
      : state)
  },

  fail(scopeId: string, message: string, ownerKind: 'voice' | 'dictation' = 'voice'): void {
    setState(state => state.activeScopeId === scopeId && state.ownerKind === ownerKind
      ? { phase: 'error', status: message, error: message }
      : state)
  },

  release(scopeId: string, ownerKind: 'voice' | 'dictation' = 'voice'): void {
    setState(state => state.activeScopeId === scopeId && state.ownerKind === ownerKind
      ? { activeScopeId: null, presenterScopeId: null, ownerKind: null, phase: 'idle', status: 'voice off', transcript: '', error: null }
      : state)
  },

  reset(): void {
    setState({ activeScopeId: null, presenterScopeId: null, ownerKind: null, phase: 'idle', status: 'voice off', transcript: '', error: null })
  },
}
