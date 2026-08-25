/**
 * AppMenu — dropdown next to the "CrewCode" brand in the window tab bar.
 * Owns app-level destinations and actions that belong with the CrewCode
 * brand menu rather than the tab strip's `+` new-tab picker.
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { BuiltinTabKind, TabKind } from '../../types'
import darkLogo from '../../assets/icon-logo-dark.png'
import lightLogo from '../../assets/icon-logo-light.png'
import { useIsDark } from '../../hooks/useIsDark'
import { getCrewCodeRuntime } from '../../runtime/crewcode-client'

/** Pull this out of the AppMenu so call sites can react to picks without
    knowing the menu's internal layout. */
export type AppMenuAction =
  // open / focus a tab kind
  | { kind: 'open-tab';    tab: BuiltinTabKind }
  // app surfaces (not tabs)
  | { kind: 'palette' }
  | { kind: 'toggle-terminal' }
  | { kind: 'start-crew' }
  | { kind: 'start-canvas' }
  | { kind: 'docs' }
  | { kind: 'updates' }
  | { kind: 'toggle-menulet' }
  | { kind: 'toggle-system-monitor' }

interface AppMenuItem {
  id:        string
  icon:      string
  label:     string
  hint?:     string
  highlight?: boolean
  action:    AppMenuAction
}

interface AppMenuGroup {
  label: string
  items: AppMenuItem[]
}

const MENU: AppMenuGroup[] = [
  {
    label: 'WORKSPACE',
    items: [
      { id: 'canvas',     icon: 'workbench',      label: 'Workbench Mode',                 action: { kind: 'start-canvas' } },
      { id: 'git',        icon: 'gitBranch', label: 'Git Workspace',                 action: { kind: 'open-tab', tab: 'git' } },
      { id: 'palette',    icon: 'palette',      label: 'Command palette',  hint: '⌘K',  action: { kind: 'palette' } },
    ],
  },
  {
    label: 'APP',
    items: [
      { id: 'settings', icon: 'settings', label: 'Settings',           hint: '⌘,', action: { kind: 'open-tab', tab: 'settings' } },
      { id: 'plugins',  icon: 'plug',     label: 'Plugins',                         action: { kind: 'open-tab', tab: 'plugins' } },
      { id: 'archive',  icon: 'archive',  label: 'Archive',                         action: { kind: 'open-tab', tab: 'archive' } },
      { id: 'updates',  icon: 'refresh',  label: 'Check for updates',               action: { kind: 'updates' } },
      { id: 'docs',     icon: 'globe',    label: 'Docs',             action: { kind: 'docs' } },
    ],
  },
]

interface AppMenuProps {
  activeKind?: TabKind
  /** Footer status — e.g., "aura@cortex · 3 active sessions". */
  footStatus?: string
  onPick:    (action: AppMenuAction) => void
}

export function AppMenu({ activeKind, footStatus, onPick }: AppMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isDark = useIsDark()
  const isWeb = getCrewCodeRuntime().kind === 'web'

  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [open])

  const handle = (a: AppMenuAction): void => {
    setOpen(false)
    onPick(a)
  }

  const isActive = (it: AppMenuItem): boolean => {
    if (it.action.kind !== 'open-tab') return false
    return it.action.tab === activeKind
  }

  return (
    <div className="appmenu-wrap" ref={ref}>
      <button
        type="button"
        className={`appmenu-trigger appmenu-trigger-logo ${open ? 'open' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="CrewCode menu"
        aria-label="CrewCode menu"
      >
        <img
          src={isDark ? darkLogo : lightLogo}
          alt="CrewCode"
          className="appmenu-trigger-logo-img"
        />
        <span className="appmenu-chev" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}>
          <Icon name="chevDown" size={16} />
        </span>
      </button>

      {open && (
        <div className="appmenu">
          <div className="appmenu-h">
            <span className="appmenu-h-t">
              <span className="appmenu-h-name">CrewCode</span>
              <span className="appmenu-h-v">v0.1.0 · {navigator.platform.toLowerCase().includes('mac') ? 'mac' : navigator.platform.toLowerCase().includes('win') ? 'win' : 'linux'}</span>
            </span>
            <span className="appmenu-h-status">
              <span className="dot" />connected
            </span>
          </div>

          {MENU.map(g => (
            <div key={g.label} className="appmenu-group">
              <div className="appmenu-sec">{g.label}</div>
              {g.items.filter(it => !isWeb || (it.id !== 'plugins' && it.id !== 'updates')).map(it => (
                <button
                  key={it.id}
                  type="button"
                  className={`appmenu-item ${isActive(it) ? 'on ' : ''}${it.highlight ? 'highlight ' : ''}`}
                  onClick={() => handle(it.action)}
                >
                  <span className="appmenu-item-ico"><Icon name={it.icon as any} size={13} /></span>
                  <span className="appmenu-item-l">{it.label}</span>
                  {/* {it.highlight && <span className="appmenu-item-new">NEW</span>} */}
                  {it.hint && <span className="appmenu-item-kbd">{it.hint}</span>}
                </button>
              ))}
            </div>
          ))}

          <div className="appmenu-foot">
            <span>{footStatus ?? 'crewcode'}</span>
            <span className="appmenu-foot-spacer" />
          </div>
        </div>
      )}
    </div>
  )
}
