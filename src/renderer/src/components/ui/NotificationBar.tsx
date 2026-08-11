import React, { useEffect, useState, useRef } from 'react'
import { useNotifications, type Notice } from '../../hooks/useNotifications'
import { PROVIDER_IMAGES, PROVIDER_META, providerImageClass } from '../composer/provider-meta'
import { isBackgroundVoicePlayback, useVoiceSessionStore } from '../../stores/voice-session-store'
import { voiceRuntime } from '../../voice/voice-session-runtime'
import { Icon } from './Icon'

function NotificationItem({ notice, dismiss }: { notice: Notice; dismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = () => {
    if (autoDismissRef.current) {
      clearTimeout(autoDismissRef.current)
      autoDismissRef.current = null
    }
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }
  }

  const scheduleDismiss = () => {
    clearTimers()
    setLeaving(true)
    exitTimerRef.current = setTimeout(() => dismiss(notice.id), 300)
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true))

    clearTimers()
    if (notice.duration && notice.duration > 0) {
      autoDismissRef.current = setTimeout(() => {
        scheduleDismiss()
      }, notice.duration)
    }

    return () => {
      cancelAnimationFrame(frame)
      clearTimers()
    }
  }, [notice.duration, notice.id, dismiss])

  const handleDismiss = () => {
    if (leaving) return
    scheduleDismiss()
  }

  const handleActivate = () => {
    if (leaving || !notice.onClick) return
    notice.onClick()
    scheduleDismiss()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!notice.onClick || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    handleActivate()
  }

  const iconMap: Record<Notice['type'], React.ComponentProps<typeof Icon>['name']> = {
    info: 'bell',
    success: 'check',
    warning: 'alert',
    error: 'close',
  }

  const colorMap: Record<Notice['type'], string> = {
    info: '#4f8cff',
    success: '#2ec27e',
    warning: '#ffb648',
    error: '#ff6b6b',
  }

  const bgMap: Record<Notice['type'], string> = {
    info: 'color-mix(in srgb, #4f8cff 10%, var(--card))',
    success: 'color-mix(in srgb, #2ec27e 10%, var(--card))',
    warning: 'color-mix(in srgb, #ffb648 12%, var(--card))',
    error: 'color-mix(in srgb, #ff6b6b 10%, var(--card))',
  }

  const providerId = notice.chatReply?.providerId ?? ''
  const providerMeta = PROVIDER_META[providerId]
  const providerName = providerMeta?.name ?? (providerId.startsWith('plugin:') ? 'Plugin agent' : providerId || 'Agent')
  const providerIcon = providerMeta?.icon ?? 'bot'
  const providerImage = PROVIDER_IMAGES[providerId]

  return (
    <div
      className={`notification-item ${notice.type} ${notice.onClick ? 'clickable' : ''} ${notice.chatReply ? 'chat-reply' : ''} ${visible ? 'visible' : ''} ${leaving ? 'leaving' : ''}`}
      role={notice.onClick ? 'button' : notice.type === 'error' ? 'alert' : 'status'}
      tabIndex={notice.onClick ? 0 : undefined}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      style={{
        '--notify-color': colorMap[notice.type],
        '--notify-bg': bgMap[notice.type],
      } as React.CSSProperties}
    >
      <div className="notify-left-border" />
      {notice.chatReply ? (
        <>
          <div className="notify-chat-provider" aria-hidden="true">
            {providerImage ? (
              <img src={providerImage} className={providerImageClass(providerId)} alt="" />
            ) : (
              <Icon name={providerIcon} size={15} />
            )}
          </div>
          <div className="notify-chat-copy">
            <div className="notify-chat-meta">
              <span className="notify-chat-name">{notice.chatReply.chatName}</span>
              <span className="notify-chat-provider-name">{providerName}</span>
              {notice.chatReply.workspaceName && <span className="notify-chat-workspace">{notice.chatReply.workspaceName}</span>}
            </div>
            <div className="notify-chat-preview">{notice.chatReply.preview}</div>
          </div>
        </>
      ) : (
        <>
          <div className="notify-icon">
            <Icon name={iconMap[notice.type]} size={14} />
          </div>
          <span className="notify-message">{notice.message}</span>
        </>
      )}
      <button
        className="notify-close"
        onClick={(e) => { e.stopPropagation(); handleDismiss() }}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label="Dismiss"
      >
        <Icon name="x" size={12} />
      </button>
      {notice.duration && notice.duration > 0 && (
        <div className="notify-progress">
          <div
            className="notify-progress-bar"
            style={{ animationDuration: `${notice.duration}ms` }}
          />
        </div>
      )}
    </div>
  )
}

interface NotificationBarProps {
  onNavigateToChat?: (scopeId: string) => void
  resolveChatSource?: (scopeId: string) => { chatName: string; workspaceName?: string }
}

export function NotificationBar({ onNavigateToChat, resolveChatSource }: NotificationBarProps) {
  const { notices, dismiss } = useNotifications()
  const backgroundVoiceScopeId = useVoiceSessionStore(state =>
    isBackgroundVoicePlayback(state) ? state.activeScopeId : null,
  )
  const backgroundVoiceSpeaking = backgroundVoiceScopeId !== null
  const [voiceNoticeScopeId, setVoiceNoticeScopeId] = useState<string | null>(null)
  const [voiceNoticeMounted, setVoiceNoticeMounted] = useState(false)
  const [voiceNoticeVisible, setVoiceNoticeVisible] = useState(false)
  const [voiceNoticeLeaving, setVoiceNoticeLeaving] = useState(false)

  useEffect(() => {
    let frame: number | null = null
    let exitTimer: ReturnType<typeof setTimeout> | null = null
    if (backgroundVoiceSpeaking) {
      setVoiceNoticeScopeId(backgroundVoiceScopeId)
      setVoiceNoticeMounted(true)
      setVoiceNoticeLeaving(false)
      frame = requestAnimationFrame(() => setVoiceNoticeVisible(true))
    } else if (voiceNoticeMounted) {
      setVoiceNoticeVisible(false)
      setVoiceNoticeLeaving(true)
      exitTimer = setTimeout(() => {
        setVoiceNoticeMounted(false)
        setVoiceNoticeLeaving(false)
      }, 300)
    }
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      if (exitTimer !== null) clearTimeout(exitTimer)
    }
  }, [backgroundVoiceScopeId, backgroundVoiceSpeaking, voiceNoticeMounted])

  const voiceSource = voiceNoticeScopeId && resolveChatSource
    ? resolveChatSource(voiceNoticeScopeId)
    : { chatName: 'another chat' }
  const canNavigateToVoiceChat = voiceNoticeScopeId !== null && onNavigateToChat !== undefined
  const navigateToVoiceChat = (): void => {
    if (voiceNoticeScopeId && onNavigateToChat) onNavigateToChat(voiceNoticeScopeId)
  }
  const handleVoiceNoticeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!canNavigateToVoiceChat || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    navigateToVoiceChat()
  }

  const displayNotices = notices.slice(0, voiceNoticeMounted ? 2 : 3)

  useEffect(() => {
    if (displayNotices.length === 0) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss(displayNotices[0].id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [displayNotices, dismiss])

  if (notices.length === 0 && !voiceNoticeMounted) return null

  const stackStyle = (index: number): React.CSSProperties => ({
    ['--stack-index' as string]: index,
    ['--stack-offset' as string]: `${index * 8}px`,
    ['--stack-scale' as string]: `${1 - index * 0.03}`,
    zIndex: 1500 - index,
  })

  return (
    <div className="notification-bar-container" aria-live="polite" aria-atomic="true">
      <div className="notification-stack">
        {voiceNoticeMounted && (
          <div className="notification-stack-item" style={stackStyle(0)}>
            <div
              className={`notification-item voice-playback-notice ${canNavigateToVoiceChat ? 'clickable' : ''} ${voiceNoticeVisible ? 'visible' : ''} ${voiceNoticeLeaving ? 'leaving' : ''}`}
              role={canNavigateToVoiceChat ? 'button' : 'status'}
              tabIndex={canNavigateToVoiceChat ? 0 : undefined}
              onClick={navigateToVoiceChat}
              onKeyDown={handleVoiceNoticeKeyDown}
              aria-label={`Voice agent reply from ${voiceSource.chatName} is playing${canNavigateToVoiceChat ? '. Open chat' : ''}`}
              style={{
                '--notify-color': 'var(--crew-green-bright)',
                '--notify-bg': 'color-mix(in srgb, var(--crew-green-bright) 10%, var(--card))',
              } as React.CSSProperties}
            >
              <div className="notify-left-border" />
              <div className="voice-notification-orb" aria-hidden="true">
                <span className="voice-notification-core" />
                <span className="voice-notification-ring" />
                <span className="voice-notification-ring is-secondary" />
              </div>
              <div className="voice-notification-copy">
                <strong>{voiceSource.chatName}</strong>
                <span>
                  Voice reply speaking
                  {voiceSource.workspaceName ? ` · ${voiceSource.workspaceName}` : ''}
                </span>
              </div>
              <button
                className="notify-close"
                onClick={(event) => {
                  event.stopPropagation()
                  voiceRuntime.stop()
                }}
                onKeyDown={(event) => event.stopPropagation()}
                aria-label="Stop voice reply"
                title="Stop voice reply"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          </div>
        )}
        {displayNotices.map((notice, i) => {
          const stackIndex = i + (voiceNoticeMounted ? 1 : 0)
          return (
            <div key={notice.id} className="notification-stack-item" style={stackStyle(stackIndex)}>
              <NotificationItem notice={notice} dismiss={dismiss} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
