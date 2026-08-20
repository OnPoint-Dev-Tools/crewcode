import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { useSettings } from '../../hooks/useSettings'

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
  return (
    <section className="canvas-mode" aria-label="Canvas Mode">
      <header className="canvas-mode-header">
        <div>
          <div className="canvas-mode-eyebrow"><Icon name="workbench" size={12} /> Workbench Mode</div>
        </div>
        <span className="canvas-mode-cap">{openChatCount} chats · {openTerminalCount} terminals open</span>
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
          {panes.map(pane => (
            <article key={pane.id} className={`canvas-mode-pane canvas-pane-${pane.kind}`}>
              <div className="canvas-mode-pane-bar">
                <span className="canvas-mode-pane-title"><Icon name={pane.kind === 'terminal' ? 'terminal' : 'threads'} size={12} /> {pane.title}</span>
                <div className="canvas-mode-pane-actions">
                  {pane.kind === 'chat' && pane.modePrompt && (
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
                  {pane.kind === 'chat' && (
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
                  <div className="canvas-mode-button" onClick={onNewChat}><Icon name="threads" size={13} /> Add chat</div>
          <div className="canvas-mode-button" onClick={onNewTerminal}><Icon name="terminal" size={13} /> Add terminal</div>
                  <button type="button" className="canvas-mode-pane-close" onClick={() => onClosePane?.(pane.id)} aria-label={`Close ${pane.title}`}>×</button>
                </div>
              </div>
              <div className="canvas-mode-pane-body">{pane.content}</div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
