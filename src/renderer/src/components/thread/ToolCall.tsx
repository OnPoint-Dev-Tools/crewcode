import React, { useState } from 'react'
import { Icon } from '../ui/Icon'
import type { ToolCallStatus } from '../../types'

interface ToolCallProps {
  toolName: string
  args:     unknown
  status:   ToolCallStatus
  result?:  unknown
  isError?: boolean
  time:     string
}

function previewArgs(args: unknown, max = 96): string {
  if (args == null) return ''
  if (typeof args === 'string') return args.length > max ? args.slice(0, max - 1) + '…' : args
  if (typeof args === 'object') {
    // For common bash-style tool inputs, prefer the `command` field for the preview.
    const obj = args as Record<string, unknown>
    if (typeof obj.command === 'string') return previewArgs(obj.command, max)
    if (typeof obj.cmd     === 'string') return previewArgs(obj.cmd, max)
    if (typeof obj.path    === 'string') return previewArgs(obj.path, max)
    try {
      const json = JSON.stringify(args)
      return json.length > max ? json.slice(0, max - 1) + '…' : json
    } catch {
      return String(args)
    }
  }
  return String(args)
}

function formatBody(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

// "bash" → "Ran command" feels natural; everything else gets a generic verb.
function verbFor(tool: string): string {
  switch (tool.toLowerCase()) {
    case 'bash':       return 'Ran command'
    case 'read':       return 'Read file'
    case 'write':      return 'Wrote file'
    case 'edit':       return 'Modified file'
    case 'glob':       return 'Globbed'
    case 'grep':       return 'Grepped'
    case 'webfetch':   return 'Fetched URL'
    case 'websearch':  return 'Searched web'
    default:           return `Called ${tool}`
  }
}

export function ToolCall({ toolName, args, status, result, isError }: ToolCallProps) {
  const [open, setOpen] = useState(true)
  const live   = status === 'pending' || status === 'running'
  const failed = isError || status === 'error'

  const subLabel =
    failed ? 'error'
    : status === 'completed' ? 'done'
    : status === 'running'   ? 'Live'
    : 'idle'

  return (
    <div className="wl">
      <div className="wl-h" onClick={() => setOpen(o => !o)}>
        <div className="wl-icon">&gt;_</div>
        <div>
          <div className="wl-t">work log</div>
          <div className="wl-sub">
            <span><span className={`dot ${live   ? 'live' : ''}`} /> {live ? 'running' : 'idle'}</span>
            <span><span className={`dot ${status === 'completed' ? 'live' : ''} ${failed ? 'err' : ''}`} /> {subLabel}</span>
          </div>
        </div>
        <div className="wl-chev" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <Icon name="chevDown" size={14} />
        </div>
      </div>
      {open && (
        <div className="wl-body">
          <div className="wl-row">
            <span className="wl-row-mark">▸</span>
            <span className="chip-mono">{toolName || 'tool'}</span>
            <span>{verbFor(toolName)} — <code>{previewArgs(args)}</code></span>
          </div>
          {failed && result !== undefined && (
            <div className="wl-detail">
              <div className="wl-detail-label">error</div>
              <pre className="wl-detail-pre err">{formatBody(result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
