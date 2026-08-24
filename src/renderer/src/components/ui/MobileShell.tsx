import { useState, useEffect, useRef, useCallback, Fragment } from 'react'
import { Icon, type IconName } from './Icon'

export type MobileTab = 'chat' | 'terminal' | 'editor' | 'git' | 'more'

interface SheetProps {
  id: string
  title: string
  children: React.ReactNode
  open: boolean
  onClose: () => void
  maxHeight?: string
}

function Sheet({ title, children, open, onClose, maxHeight = 'calc(100vh - 120px)' }: SheetProps) {
  const handleRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const startYRef = useRef(0)
  const currentYRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  useEffect(() => {
    if (!open && contentRef.current) contentRef.current.style.transform = ''
  }, [open])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.target !== handleRef.current && !handleRef.current?.contains(e.target as Node)) return
    setDragging(true)
    startYRef.current = e.touches[0].clientY
    currentYRef.current = 0
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragging) return
    currentYRef.current = e.touches[0].clientY - startYRef.current
    if (currentYRef.current > 0 && contentRef.current) {
      contentRef.current.style.transform = `translateY(${currentYRef.current}px)`
    }
  }, [dragging])

  const handleTouchEnd = useCallback(() => {
    if (!dragging) return
    setDragging(false)
    if (currentYRef.current > 100) onClose()
    else if (contentRef.current) contentRef.current.style.transform = ''
  }, [dragging, onClose])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target !== handleRef.current && !handleRef.current?.contains(e.target as Node)) return
    setDragging(true)
    startYRef.current = e.clientY
    currentYRef.current = 0
    const move = (me: MouseEvent) => {
      currentYRef.current = me.clientY - startYRef.current
      if (currentYRef.current > 0 && contentRef.current) {
        contentRef.current.style.transform = `translateY(${currentYRef.current}px)`
      }
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      setDragging(false)
      if (currentYRef.current > 100) onClose()
      else if (contentRef.current) contentRef.current.style.transform = ''
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }, [onClose])

  if (!open) return null

  return (
    <Fragment>
      <div
        className="sheet-backdrop"
        onClick={onClose}
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 1100,
          animation: 'sheetBackdropIn 150ms ease-out',
        }}
      />
      <div
        ref={contentRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseDown={handleMouseDown}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1200,
          background: 'var(--background)',
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          border: '1px solid var(--border)',
          borderBottom: 'none',
          maxHeight,
          display: 'flex',
          flexDirection: 'column',
          animation: dragging ? undefined : 'sheetIn 250ms cubic-bezier(.2,.8,.2,1)',
          transition: dragging ? 'none' : 'transform 200ms cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <div
          ref={handleRef}
          className="sheet-handle"
          style={{
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'grab',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
            touchAction: 'none',
          }}
        >
          <div style={{ width: 40, height: 4, borderRadius: 999, background: 'var(--muted-foreground)', opacity: 0.4 }} />
        </div>
        <div className="sheet-header" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <h2 className="cc-h3" style={{ margin: 0 }}>{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 44, height: 44, borderRadius: 999, border: '1px solid var(--border)',
              background: 'var(--card)', color: 'var(--muted-foreground)',
              display: 'grid', placeItems: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="sheet-content" style={{ flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch' as any, overscrollBehavior: 'contain' }}>
          {children}
        </div>
      </div>
    </Fragment>
  )
}

interface BottomNavProps {
  activeTab: MobileTab
  onTabChange: (tab: MobileTab) => void
  unreadCounts?: Record<MobileTab, number>
  sheets: Record<string, boolean>
  onSheetToggle: (id: string) => void
}

function BottomNav({ activeTab, onTabChange, unreadCounts, sheets, onSheetToggle }: BottomNavProps) {
  const tabs: { id: MobileTab; icon: IconName; label: string; sheetId?: string }[] = [
    { id: 'chat', icon: 'chat', label: 'Chat' },
    { id: 'terminal', icon: 'terminal', label: 'Terminal', sheetId: 'terminal' },
    { id: 'editor', icon: 'code', label: 'Editor' },
    { id: 'git', icon: 'branch', label: 'Git', sheetId: 'git' },
    { id: 'more', icon: 'more', label: 'More', sheetId: 'more' },
  ]

  return (
    <nav
      className="mobile-bottom-nav"
      aria-label="Mobile navigation"
      style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        height: 'calc(56px + env(safe-area-inset-bottom))',
        display: 'flex', alignItems: 'center', justifyContent: 'space-around',
        background: 'var(--crew-term)', borderTop: '1px solid var(--border)',
        zIndex: 1000, paddingBottom: 'env(safe-area-inset-bottom)', paddingTop: 4,
      }}
    >
      {tabs.map((tab) => {
        const active = activeTab === tab.id || (!!tab.sheetId && !!sheets[tab.sheetId])
        return (
          <button
            key={tab.id}
            onClick={() => { if (tab.sheetId) onSheetToggle(tab.sheetId); else onTabChange(tab.id) }}
            aria-label={tab.label}
            aria-current={active ? 'page' : undefined}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              padding: '4px 8px', border: 'none', background: 'transparent',
              color: active ? 'var(--primary)' : 'var(--muted-foreground)',
              fontFamily: 'var(--font-family-sans)', fontSize: 10, fontWeight: 500,
              cursor: 'pointer', minWidth: 44, minHeight: 44, position: 'relative',
            }}
          >
            <Icon name={tab.icon} size={24} />
            <span>{tab.label}</span>
            {(unreadCounts?.[tab.id] ?? 0) > 0 && (
              <span style={{
                position: 'absolute', top: 0, right: 0, minWidth: 16, height: 16, borderRadius: 999,
                background: 'var(--destructive)', color: 'white', fontSize: 10,
                fontFamily: 'var(--font-family-mono)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
              }}>
                {(unreadCounts?.[tab.id] ?? 0) > 9 ? '9+' : (unreadCounts?.[tab.id] ?? 0)}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}

interface MobileShellProps {
  children: React.ReactNode
  activeTab: MobileTab
  onTabChange: (tab: MobileTab) => void
  sheets: Record<string, { open: boolean; title: string; content: React.ReactNode }>
  onSheetToggle: (id: string) => void
  unreadCounts?: Record<MobileTab, number>
}

export function MobileShell({ children, activeTab, onTabChange, sheets, onSheetToggle, unreadCounts }: MobileShellProps) {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  if (!isMobile) return <>{children}</>
  return (
    <div className="mobile-shell" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, position: 'relative', paddingBottom: 'calc(56px + env(safe-area-inset-bottom))' }}>{children}</div>
      <BottomNav activeTab={activeTab} onTabChange={onTabChange} unreadCounts={unreadCounts} sheets={Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, v.open]))} onSheetToggle={onSheetToggle} />
      {Object.entries(sheets).map(([id, sheet]) => sheet.open && (
        <Sheet key={id} id={id} title={sheet.title} open={sheet.open} onClose={() => onSheetToggle(id)}>{sheet.content}</Sheet>
      ))}
    </div>
  )
}

export function useMobileShell() {
  const [activeTab, setActiveTab] = useState<MobileTab>('chat')
  const [sheets, setSheets] = useState<Record<string, { open: boolean; title: string; content: React.ReactNode }>>({})

  const onTabChange = useCallback((tab: MobileTab) => {
    setActiveTab(tab)
    setSheets(prev => {
      const next = { ...prev }
      let dirty = false
      for (const k of Object.keys(next)) if (next[k].open) { next[k] = { ...next[k], open: false }; dirty = true }
      return dirty ? next : prev
    })
  }, [])

  const onSheetToggle = useCallback((id: string) => {
    setSheets(prev => ({ ...prev, [id]: { ...prev[id], open: !prev[id]?.open, title: prev[id]?.title ?? id, content: prev[id]?.content ?? null } }))
  }, [])

  const openSheet = useCallback((id: string, title: string, content: React.ReactNode) => {
    setSheets(prev => {
      const next: typeof prev = {}
      for (const [k, v] of Object.entries(prev)) next[k] = k === id ? { open: true, title, content } : { ...v, open: false }
      if (!next[id]) next[id] = { open: true, title, content }
      else next[id] = { open: true, title, content }
      return next
    })
  }, [])

  const closeSheet = useCallback((id: string) => {
    setSheets(prev => ({ ...prev, [id]: { ...prev[id], open: false } }))
  }, [])

  return { activeTab, onTabChange, sheets, onSheetToggle, openSheet, closeSheet, setActiveTab }
}
