import React, { useEffect, useRef, useState } from 'react'

// Token-driven styles so the floating surface follows appTheme + color-theme
// swaps without needing a React re-render.
const PANEL_CSS = `
.twk-launcher,
.twk-panel{position:fixed;right:16px;bottom:16px;z-index:9999;font-family:var(--font-family-sans);color:var(--foreground)}
.twk-launcher{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:999px;background:color-mix(in srgb,var(--popover) 92%,transparent);padding:7px 11px;box-shadow:0 10px 30px rgba(0,0,0,.24);backdrop-filter:blur(18px) saturate(130%);-webkit-backdrop-filter:blur(18px) saturate(130%);font-family:var(--font-family-mono);font-size:11px;color:var(--muted-foreground);cursor:pointer;user-select:none;transition:background 140ms ease,border-color 140ms ease,color 140ms ease,transform 140ms ease}
.twk-launcher:hover{background:var(--popover);border-color:var(--primary,#285a48);color:var(--foreground);transform:translateY(-1px)}
.twk-launcher-dot{width:6px;height:6px;border-radius:999px;background:var(--primary,#285a48);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary,#285a48) 18%,transparent)}
.twk-panel{width:min(320px,calc(100vw - 32px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border);border-radius:14px;background:color-mix(in srgb,var(--popover) 94%,transparent);box-shadow:0 18px 48px rgba(0,0,0,.38);backdrop-filter:blur(22px) saturate(135%);-webkit-backdrop-filter:blur(22px) saturate(135%)}
body.light .twk-panel,body.light .twk-launcher{box-shadow:0 16px 40px rgba(15,18,15,.14)}
.twk-panel::before{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--foreground) 18%,transparent),transparent);pointer-events:none}
.twk-hd{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 12px 10px 14px;cursor:move;user-select:none;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--card) 56%,transparent)}
.twk-title{display:flex;flex-direction:column;gap:2px;min-width:0}.twk-title b{font-size:12.5px;font-weight:650;letter-spacing:.01em;color:var(--foreground)}.twk-title span{font-family:var(--font-family-mono);font-size:10px;letter-spacing:.08em;text-transform:lowercase;color:var(--muted-foreground)}
.twk-x{appearance:none;border:1px solid transparent;background:transparent;color:var(--muted-foreground);width:26px;height:26px;border-radius:7px;cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center;-webkit-app-region:no-drag}.twk-x:hover{background:var(--accent);border-color:var(--border);color:var(--foreground)}
.twk-body{padding:10px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;overflow-x:hidden;min-height:0}.twk-card{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--border);border-radius:11px;background:var(--card);}
.twk-sect{font-family:var(--font-family-mono);font-size:10px;font-weight:650;letter-spacing:.11em;text-transform:uppercase;color:var(--muted-foreground);padding:8px 4px 2px}.twk-sect:first-child{padding-top:2px}
.twk-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:30px}.twk-lbl{font-size:12px;color:var(--foreground)}.twk-val{font-family:var(--font-family-mono);font-size:10.5px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
.twk-radio{display:flex;gap:2px;max-width:190px;overflow:auto;padding:3px;border:1px solid var(--border);border-radius:9px;background:var(--background)}.twk-radio button{font:500 11px/1 var(--font-family-sans);padding:6px 9px;border-radius:6px;border:0;background:transparent;color:var(--muted-foreground);cursor:pointer;white-space:nowrap}.twk-radio button.on{background:var(--primary,#285a48);color:#fafafa}.twk-radio button:hover:not(.on){background:var(--accent);color:var(--foreground)}
.twk-slider{width:100%;display:flex;align-items:center}.twk-slider input[type=range]{width:100%;accent-color:var(--primary,#285a48);cursor:pointer}
.twk-colors{display:flex;gap:5px;flex-wrap:wrap}.twk-swatch{width:22px;height:22px;border-radius:7px;border:1px solid var(--border);cursor:pointer}.twk-swatch.on{outline:1px solid var(--foreground);outline-offset:2px}.twk-btn{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:var(--background);color:var(--muted-foreground);font-size:12px;cursor:pointer;text-align:left}.twk-btn::after{content:"›";font-family:var(--font-family-mono);color:var(--muted-foreground)}.twk-btn:hover{background:var(--accent);color:var(--foreground)}.twk-btn.secondary{background:color-mix(in srgb,var(--primary,#285a48) 14%,var(--background));border-color:color-mix(in srgb,var(--primary,#285a48) 50%,var(--border));color:var(--foreground)}
`

export function TweakSection({ label }: { label: string }) {
  return <div className="twk-sect">{label}</div>
}

export function TweakRadio({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void
}) {
  return (
    <div className="twk-card">
      <div className="twk-row">
        <span className="twk-lbl">{label}</span>
        <div className="twk-radio" role="radiogroup" aria-label={label}>
          {options.map(opt => (
            <button key={opt} className={value === opt ? 'on' : ''} onClick={() => onChange(opt)} role="radio" aria-checked={value === opt}>{opt}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function TweakColor({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void
}) {
  return (
    <div className="twk-card">
      <div className="twk-row">
        <span className="twk-lbl">{label}</span>
        <div className="twk-colors">
          {options.map(c => (
            <button
              key={c}
              type="button"
              className={`twk-swatch ${value === c ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => onChange(c)}
              aria-label={c}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function TweakSlider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void
}) {
  return (
    <div className="twk-card">
      <div className="twk-row">
        <span className="twk-lbl">{label}</span>
        <span className="twk-val">{value}{unit}</span>
      </div>
      <div className="twk-slider">
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          aria-label={label}
        />
      </div>
    </div>
  )
}

export function TweakButton({ label, onClick, secondary }: {
  label: string; onClick: () => void; secondary?: boolean
}) {
  return (
    <button className={`twk-btn ${secondary ? 'secondary' : ''}`} onClick={onClick}>{label}</button>
  )
}

interface TweaksPanelProps {
  title?: string
  children: React.ReactNode
}

export function TweaksPanel({ title = 'Layout Panel', children }: TweaksPanelProps) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const pos = useRef({ x: 0, y: 0, startX: 0, startY: 0 })
  const dragging = useRef(false)

  useEffect(() => {
    if (document.getElementById('twk-css')) return
    const el = document.createElement('style')
    el.id = 'twk-css'
    el.textContent = PANEL_CSS
    document.head.appendChild(el)
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragging.current = true
    pos.current.startX = e.clientX - pos.current.x
    pos.current.startY = e.clientY - pos.current.y
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !panelRef.current) return
      pos.current.x = ev.clientX - pos.current.startX
      pos.current.y = ev.clientY - pos.current.startY
      panelRef.current.style.transform = `translate(${pos.current.x}px, ${pos.current.y}px)`
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!open) {
    return (
      <button type="button" className="twk-launcher" onClick={() => setOpen(true)}>
        <span className="twk-launcher-dot" aria-hidden /> Customize
      </button>
    )
  }

  return (
    <div ref={panelRef} className="twk-panel">
      <div className="twk-hd" onMouseDown={onMouseDown}>
        <span className="twk-title">
          <b>{title}</b>
          <span>workspace controls</span>
        </span>
        <button className="twk-x" onClick={() => setOpen(false)} aria-label="Close tweaks">×</button>
      </div>
      <div className="twk-body">{children}</div>
    </div>
  )
}
