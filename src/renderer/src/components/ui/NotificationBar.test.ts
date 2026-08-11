import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationsProvider } from '../../hooks/useNotifications'
import { voiceSession } from '../../stores/voice-session-store'
import { NotificationBar } from './NotificationBar'

beforeEach(() => {
  vi.useFakeTimers()
  voiceSession.reset()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  voiceSession.reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('NotificationBar background voice playback', () => {
  it('identifies and opens the origin chat, then exits after speech', () => {
    voiceSession.claim('origin-chat')
    voiceSession.detachPresenter('origin-chat')
    voiceSession.attachPresenter('visible-chat')
    voiceSession.setPhase('origin-chat', 'speaking', 'Speaking')

    const navigate = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(
        NotificationsProvider,
        null,
        createElement(NotificationBar, {
          onNavigateToChat: navigate,
          resolveChatSource: () => ({ chatName: 'CUDA debugging', workspaceName: 'CrewCode' }),
        }),
      ))
    })

    const notice = renderer!.root.findByProps({
      'aria-label': 'Voice agent reply from CUDA debugging is playing. Open chat',
    })
    expect(notice.findByType('strong').children).toEqual(['CUDA debugging'])
    expect(notice.findAllByType('span').some(span => span.children.join('').includes('CrewCode'))).toBe(true)

    act(() => notice.props.onClick())
    expect(navigate).toHaveBeenCalledWith('origin-chat')

    act(() => {
      voiceSession.release('origin-chat')
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(renderer!.root.findAllByProps({
      'aria-label': 'Voice agent reply from CUDA debugging is playing. Open chat',
    })).toHaveLength(0)
  })
})
