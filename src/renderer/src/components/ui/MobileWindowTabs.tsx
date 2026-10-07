import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { AgentActivityIndicator } from './AgentActivityIndicator'
import { NEW_TAB_ACTIONS, TAB_ICONS, type WindowTab, type WindowTabPluginMenuItem } from './WindowTabs'
import type { BuiltinTabKind } from '../../types'
import type { CrewSessionState } from '../../orchestrator/crew-session'

interface MobileWindowTabsProps {
  tabs: WindowTab[]
  activeId: string
  crewTabs: Record<string, CrewSessionState>
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNewTab: (kind: BuiltinTabKind) => void
  pluginMenuItems: WindowTabPluginMenuItem[]
  onPluginMenuItem: (item: WindowTabPluginMenuItem) => void
}

export function MobileWindowTabs({ tabs, activeId, crewTabs, onActivate, onClose, onNewTab, pluginMenuItems, onPluginMenuItem }: MobileWindowTabsProps) {
  const [adding, setAdding] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sheet = contentRef.current?.closest<HTMLElement>('.sheet')
    if (!sheet) return
    const previous = document.activeElement as HTMLElement | null
    const selected = sheet.querySelector<HTMLElement>('[aria-current="page"]')
    ;(selected ?? sheet.querySelector<HTMLElement>('button'))?.focus()
    selected?.scrollIntoView({ block: 'nearest' })
    // Keep keyboard focus inside this modal and return it to the dock trigger.
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const buttons = [...sheet.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.removeEventListener('keydown', trap)
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  const canvasTabs = tabs.filter(tab => tab.kind === 'canvas')
  const visibleTabs = [...tabs.filter(tab => tab.pinned), ...tabs.filter(tab => !tab.pinned)]

  return (
    <div className="mobile-window-tabs" ref={contentRef}>
      <button type="button" className="mobile-tabs-new" aria-expanded={adding} onClick={() => setAdding(value => !value)}>
        <Icon name={adding ? 'chevLeft' : 'plus'} size={18} />
        {adding ? 'Back to open tabs' : 'New tab'}
      </button>
      {adding ? (
        <div className="mobile-tabs-list" aria-label="New tab choices">
          {NEW_TAB_ACTIONS.map(item => (
            <button key={item.kind} type="button" className="mobile-tab-select" onClick={() => onNewTab(item.kind)}>
              <Icon name={item.icon as any} size={18} /><span>{item.label}</span>
            </button>
          ))}
          {pluginMenuItems.map(item => (
            <button key={item.id} type="button" className="mobile-tab-select" onClick={() => onPluginMenuItem(item)}>
              <Icon name="plug" size={18} /><span>{item.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mobile-tabs-list" aria-label="Open tabs">
          {visibleTabs.length === 0 && <p>No open tabs. Create one above.</p>}
          {visibleTabs.map(tab => {
            const crewState = crewTabs[tab.id]
            const canvasNumber = canvasTabs.length > 1 ? canvasTabs.findIndex(item => item.id === tab.id) + 1 : null
            const label = tab.kind === 'canvas' ? `Workbench Mode${canvasNumber ? ` ${canvasNumber}` : ''}` : tab.label
            return (
              <div key={tab.id} className={`mobile-tab-row${tab.id === activeId ? ' on' : ''}`}>
                <button type="button" className="mobile-tab-select" aria-current={tab.id === activeId ? 'page' : undefined} onClick={() => onActivate(tab.id)}>
                  <Icon name={TAB_ICONS[tab.kind] as any} size={18} />
                  <span className="mobile-tab-label">{label}{tab.pinned && <small>Pinned</small>}{crewState && <small>Crew · {crewState}</small>}</span>
                  <AgentActivityIndicator state={tab.agentActivity} />
                  {tab.live && !tab.agentActivity && !crewState && <small>Live</small>}
                  {tab.id === activeId && <Icon name="check" size={16} />}
                </button>
                {!tab.pinned && <button type="button" className="mobile-tab-close" aria-label={`Close ${label}`} onClick={() => onClose(tab.id)}><Icon name="x" size={18} /></button>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
