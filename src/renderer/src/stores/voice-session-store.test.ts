import { beforeEach, describe, expect, it } from 'vitest'

import {
  isBackgroundVoicePlayback,
  isVoiceSessionPresentedInScope,
  useVoiceSessionStore,
  voiceSession,
} from './voice-session-store'

const state = () => useVoiceSessionStore.getState()

beforeEach(() => voiceSession.reset())

describe('voice-session-store', () => {
  it('keeps one active voice owner and ignores stale pane updates', () => {
    voiceSession.claim('scope-a')
    voiceSession.setPhase('scope-a', 'listening', 'listening')
    voiceSession.setTranscript('scope-a', 'hello')

    voiceSession.claim('scope-b')
    voiceSession.setPhase('scope-a', 'speaking', 'stale')
    voiceSession.release('scope-a')

    expect(state()).toMatchObject({
      activeScopeId: 'scope-b',
      presenterScopeId: 'scope-b',
      phase: 'connecting',
      status: 'connecting',
      transcript: '',
    })
  })

  it('moves presentation without releasing the active voice target', () => {
    voiceSession.claim('origin')
    voiceSession.detachPresenter('origin')

    expect(state()).toMatchObject({
      activeScopeId: 'origin',
      presenterScopeId: null,
      ownerKind: 'voice',
    })

    voiceSession.attachPresenter('visible-chat')
    expect(state()).toMatchObject({
      activeScopeId: 'origin',
      presenterScopeId: 'visible-chat',
      ownerKind: 'voice',
    })
  })

  it('keeps the overlay in the origin and identifies background reply playback', () => {
    voiceSession.claim('origin')
    voiceSession.detachPresenter('origin')
    voiceSession.attachPresenter('visible-chat')
    voiceSession.setPhase('origin', 'speaking', 'Speaking')

    expect(isVoiceSessionPresentedInScope(state(), 'origin')).toBe(false)
    expect(isVoiceSessionPresentedInScope(state(), 'visible-chat')).toBe(false)
    expect(isBackgroundVoicePlayback(state())).toBe(true)

    voiceSession.attachPresenter('origin')
    expect(isVoiceSessionPresentedInScope(state(), 'origin')).toBe(true)
    expect(isBackgroundVoicePlayback(state())).toBe(false)
  })

  it('records and clears an active transport failure', () => {
    voiceSession.claim('scope-a')
    voiceSession.fail('scope-a', 'microphone denied')
    expect(state()).toMatchObject({
      phase: 'error',
      status: 'microphone denied',
      error: 'microphone denied',
    })

    voiceSession.release('scope-a')
    expect(state()).toMatchObject({
      activeScopeId: null,
      phase: 'idle',
      error: null,
    })
  })

  it('holds an editable transcript for confirmation before agent routing', () => {
    voiceSession.claim('scope-a')
    voiceSession.requestConfirmation('scope-a', 'Run the focused tests')

    expect(state()).toMatchObject({
      activeScopeId: 'scope-a',
      ownerKind: 'voice',
      phase: 'confirming',
      status: 'Review before sending',
      transcript: 'Run the focused tests',
    })

    voiceSession.setTranscript('scope-a', 'Run only the voice tests')
    expect(state().transcript).toBe('Run only the voice tests')
  })

  it('keeps dictation isolated from stale orb events in the same scope', () => {
    voiceSession.claim('scope-a', 'dictation')
    voiceSession.setTranscript('scope-a', 'stale voice transcript')
    voiceSession.fail('scope-a', 'stale voice error')

    expect(state()).toMatchObject({
      activeScopeId: 'scope-a',
      ownerKind: 'dictation',
      phase: 'connecting',
      transcript: '',
      error: null,
    })
  })
})
