import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { useSettings } from '../../hooks/useSettings'
import { useMobileLayout } from '../../hooks/useMobileLayout'

export type CanvasPaneKind = 'chat' | 'terminal'

export interface CanvasPaneView {
  id: string
  kind: CanvasPaneKind
  title: string
  content: ReactNode
  modePrompt?: {
    enabled: boolean
    locked: boolean
    onToggle: () => void
  }
}

interface CanvasModeProps {
  workspaceName: string
  openChatCount: number
  openTerminalCount: number
  panes: CanvasPaneView[]
  onNewChat?: () => void
  onNewTerminal?: () => void
  onClosePane?: (paneId: string) => void
}

export function CanvasMode({ workspaceName, openChatCount, openTerminalCount, panes, onNewChat, onNewTerminal, onClosePane }: CanvasModeProps) {
  const { state: settings, set: setSetting } = useSettings()
  const { isMobile } = useMobileLayout()
  const [fabOpen, setFabOpen] = useState(false)
  // Per-pane overflow menu. `null` = closed; otherwise the open pane's id.
  const [paneMenuId, setPaneMenuId] = useState<string | null>(null)
  const paneMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!paneMenuId) return
    const onDown = (e: MouseEvent | TouchEvent): void => {
      if (paneMenuRef.current && !paneMenuRef.current.contains(e.target as Node)) {
        setPaneMenuId(null)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPaneMenuId(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [paneMenuId])

  return (
    <section className="canvas-mode" aria-label="Canvas Mode">
      <header className="canvas-mode-header">
        <div>
          <div className="canvas-mode-eyebrow"><Icon name="workbench" size={12} /> Workbench Mode</div>
        </div>
        <span className="canvas-mode-cap">
          {isMobile
            ? `${openChatCount + openTerminalCount} open`
            : `${openChatCount} chats · ${openTerminalCount} terminals open`}
        </span>
      </header>

      {panes.length === 0 ? (
        <div className="canvas-mode-hub">
          <article className="canvas-mode-start-card">
            <div className="canvas-mode-start-icon"><Icon name="threads" size={20} /></div>
            <div>
              <h2>Add a canvas chat</h2>
              <p>Create multiple chats.</p>
            </div>
            <button type="button" className="canvas-mode-button" onClick={onNewChat}>Add chat</button>
          </article>

          <article className="canvas-mode-start-card">
            <div className="canvas-mode-start-icon"><Icon name="terminal" size={20} /></div>
            <div>
              <h2>Add a canvas terminal</h2>
              <p>Create multiple terminals alongside chats.</p>
            </div>
            <button type="button" className="canvas-mode-button" onClick={onNewTerminal}>Add terminal</button>
          </article>

          {/* <article className="canvas-mode-note">
            <div className="canvas-mode-eyebrow"><Icon name="inspection" size={12} /> Performance guardrail</div>
            <p>Canvas does not load existing live tabs. Future hardening should virtualize off-screen canvas panes and cap simultaneous terminal mounts.</p>
          </article> */}
        </div>
      ) : (
        <div className="canvas-mode-pane-grid">
          {panes.map(pane => {
            const isChat = pane.kind === 'chat'
            const menuOpen = paneMenuId === pane.id
            return (
              <article key={pane.id} className={`canvas-mode-pane canvas-pane-${pane.kind}`}>
                <div className="canvas-mode-pane-bar">
                  <span className="canvas-mode-pane-title"><Icon name={isChat ? 'threads' : 'terminal'} size={12} /> {pane.title}</span>
                  {isMobile ? (
                    // Phone: collapse the action cluster into a single
                    // overflow button. The popover carries prompt toggle,
                    // verbose-log toggle, and close. Add chat / Add terminal
                    // live on the page-level FAB.
                    <div className="canvas-mode-pane-menu" ref={menuOpen ? paneMenuRef : undefined}>
                      <button
                        type="button"
                        className="canvas-mode-pane-more"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-label={`More actions for ${pane.title}`}
                        onClick={() => setPaneMenuId(menuOpen ? null : pane.id)}
                      >
                        <Icon name="more" size={14} />
                      </button>
                      {menuOpen && (
                        <div className="canvas-mode-pane-menu-pop" role="menu">
                          {isChat && pane.modePrompt && (
                            <button
                              type="button"
                              role="menuitem"
                              className="canvas-mode-pane-menu-item"
                              onClick={() => { pane.modePrompt!.onToggle(); setPaneMenuId(null) }}
                              disabled={pane.modePrompt.locked}
                            >
                              <Icon name="bot" size={13} />
                              <span className="lbl">Mode prompt</span>
                              <span className={`canvas-mode-pane-toggle-track ${pane.modePrompt.enabled ? 'on' : ''}`} aria-hidden>
                                <span className="canvas-mode-pane-toggle-thumb" />
                              </span>
                            </button>
                          )}
                          {isChat && (
                            <button
                              type="button"
                              role="menuitem"
                              className="canvas-mode-pane-menu-item"
                              onClick={() => { setSetting('hideVerboseAgentLogs', !settings.hideVerboseAgentLogs); setPaneMenuId(null) }}
                            >
                              <Icon name={settings.hideVerboseAgentLogs ? 'eyeOff' : 'eye'} size={13} />
                              <span className="lbl">{settings.hideVerboseAgentLogs ? 'Show logs' : 'Hide logs'}</span>
                            </button>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            className="canvas-mode-pane-menu-item danger"
                            onClick={() => { onClosePane?.(pane.id); setPaneMenuId(null) }}
                          >
                            <Icon name="x" size={13} />
                            <span className="lbl">Close pane</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    // Desktop: keep the full inline cluster (mode prompt,
                    // logs toggle, Add chat, Add terminal, close).
                    <div className="canvas-mode-pane-actions">
                      {isChat && pane.modePrompt && (
                        <button
                          type="button"
                          className={`canvas-mode-pane-log canvas-mode-pane-prompt ${pane.modePrompt.enabled ? 'on' : ''}`}
                          onClick={pane.modePrompt.onToggle}
                          title={pane.modePrompt.locked
                            ? `Mode prompt ${pane.modePrompt.enabled ? 'was enabled' : 'was disabled'} when this session started`
                            : pane.modePrompt.enabled
                              ? 'CrewCode mode prompt on — click to use only provider context for this session'
                              : 'CrewCode mode prompt off — click to add mode guidance for this session'}
                          aria-label="Inject CrewCode mode prompt for this Workbench chat"
                          aria-pressed={pane.modePrompt.enabled}
                          disabled={pane.modePrompt.locked}
                        >
                          <Icon name="bot" size={12} />
                          <span>prompt</span>
                          <span className="canvas-mode-pane-toggle-track" aria-hidden>
                            <span className="canvas-mode-pane-toggle-thumb" />
                          </span>
                        </button>
                      )}
                      {isChat && (
                        <button
                          type="button"
                          className={`canvas-mode-pane-log ${settings.hideVerboseAgentLogs ? 'on' : ''}`}
                          onClick={() => setSetting('hideVerboseAgentLogs', !settings.hideVerboseAgentLogs)}
                          title={settings.hideVerboseAgentLogs ? 'Show thinking and tool logs' : 'Hide thinking and tool logs'}
                          aria-pressed={settings.hideVerboseAgentLogs}
                        >
                          <Icon name={settings.hideVerboseAgentLogs ? 'eyeOff' : 'eye'} size={12} />
                          <span>{settings.hideVerboseAgentLogs ? 'replies' : 'logs'}</span>
                        </button>
                      )}
                      <button type="button" className="canvas-mode-button" onClick={onNewChat}>
                        <Icon name="threads" size={13} /> Add chat
                      </button>
                      <button type="button" className="canvas-mode-button" onClick={onNewTerminal}>
                        <Icon name="terminal" size={13} /> Add terminal
                      </button>
                      <button type="button" className="canvas-mode-pane-close" onClick={() => onClosePane?.(pane.id)} aria-label={`Close ${pane.title}`}>×</button>
                    </div>
                  )}
                </div>
                <div className="canvas-mode-pane-body">{pane.content}</div>
              </article>
            )
          })}
        </div>
      )}

      {/* Phone-only FAB: in the empty-hub case the start cards already expose
          the Add buttons. Once the user has at least one pane, the only way
          to add another is from inside that pane's title bar. On phones that
          bar overflows, so we surface a sticky FAB with the same actions. */}
      {isMobile && panes.length > 0 && (
        <div className="canvas-mode-fab-wrap">
          {fabOpen && (
            <div className="canvas-mode-fab-menu" role="menu">
              <button type="button" role="menuitem"
                className="canvas-mode-fab-item"
                onClick={() => { setFabOpen(false); onNewChat?.() }}>
                <Icon name="threads" size={14} /> Add chat
              </button>
              <button type="button" role="menuitem"
                className="canvas-mode-fab-item"
                onClick={() => { setFabOpen(false); onNewTerminal?.() }}>
                <Icon name="terminal" size={14} /> Add terminal
              </button>
            </div>
          )}
          <button
            type="button"
            className="canvas-mode-fab"
            aria-label={fabOpen ? 'close add menu' : 'add chat or terminal'}
            aria-expanded={fabOpen}
            onClick={() => setFabOpen(o => !o)}
          >
            <Icon name={fabOpen ? 'x' : 'plus'} size={18} />
          </button>
        </div>
      )}
    </section>
  )
}
