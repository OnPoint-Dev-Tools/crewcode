import { useEffect, useMemo, useRef, useState } from 'react'

import type { Tab, Workspace } from '../../types'
import { CREWCODE_PLUGIN_API_VERSION, PLUGIN_IFRAME_SANDBOX } from '../../../../shared/plugin-types'
import type { PluginInvokeMethod, PluginResolveTabResult } from '../../../../shared/plugin-types'

interface PluginTabHostProps {
  tab: Tab
  workspace: Workspace | null
}

type PluginFrameMessage =
  | {
      type: 'crewcode:request'
      id: string
      method: PluginInvokeMethod
      params?: Record<string, unknown>
    }
  | {
      type: 'crewcode:runtimeError'
      message?: string
      stack?: string
    }

export function PluginTabHost({ tab, workspace }: PluginTabHostProps) {
  const registrationId = tab.pluginRegistrationId ?? ''
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [resolved, setResolved] = useState<PluginResolveTabResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([])

  const reload = () => {
    setRuntimeErrors([])
    setReloadNonce(n => n + 1)
  }

  useEffect(() => {
    let cancelled = false
    setResolved(null)
    setError(null)

    if (!registrationId) {
      setError('plugin tab is missing registration metadata')
      return
    }

    const api = window.electronAPI
    if (!api?.pluginsResolveTab) {
      setError('plugin API unavailable')
      return
    }

    api.pluginsResolveTab(registrationId).then(result => {
      if (cancelled) return
      setResolved(result)
      if (!result.ok) setError(result.error)
    }).catch((err: Error) => {
      if (!cancelled) setError(err.message)
    })

    return () => { cancelled = true }
  }, [registrationId, reloadNonce])

  useEffect(() => {
    const off = window.electronAPI?.onPluginsChanged?.(() => reload())
    return () => off?.()
  }, [])

  const iframeName = useMemo(() => `crewcode-plugin:${registrationId}`, [registrationId])

  useEffect(() => {
    if (!resolved?.ok) return
    const onMessage = async (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow
      if (!frame || event.source !== frame) return
      const data = event.data as Partial<PluginFrameMessage>
      if (!data || typeof data !== 'object') return
      if (data.type === 'crewcode:runtimeError') {
        const message = typeof data.message === 'string' ? data.message : 'plugin runtime error'
        const stack = typeof data.stack === 'string' ? data.stack : ''
        const fullMessage = `${message}${stack ? `\n${stack}` : ''}`
        setRuntimeErrors(prev => [fullMessage, ...prev].slice(0, 3))
        void window.electronAPI?.pluginsRecordRuntimeError?.(resolved.pluginId, registrationId, fullMessage)
        return
      }
      if (data.type !== 'crewcode:request' || typeof data.id !== 'string' || typeof data.method !== 'string') return

      const result = await window.electronAPI?.pluginsInvoke?.({
        registrationId,
        method: data.method as PluginInvokeMethod,
        workspaceRoot: workspace?.path,
        params: data.params,
      }) ?? { ok: false, error: 'plugin API unavailable' }

      if (!result.ok) setRuntimeErrors(prev => [`${data.method}: ${result.error}`, ...prev].slice(0, 3))
      frame.postMessage({ type: 'crewcode:response', id: data.id, ...result }, '*')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [registrationId, resolved, workspace?.path])

  const postContext = () => {
    if (!resolved?.ok) return
    iframeRef.current?.contentWindow?.postMessage({
      type: 'crewcode:context',
      // Lets plugins feature-detect the running host without a handshake round-trip.
      hostApiVersion: CREWCODE_PLUGIN_API_VERSION,
      pluginId: resolved.pluginId,
      registrationId: resolved.registrationId,
      workspace: workspace ? { id: workspace.id, name: workspace.name, kind: workspace.kind } : null,
      permissions: resolved.permissions,
      openContext: tab.pluginOpenContext ?? { source: 'restored-tab' },
    }, '*')
  }

  if (error) {
    return (
      <div className="plugin-tab-host plugin-tab-error" style={{ padding: 20 }}>
        <div className="smallcaps">plugin unavailable</div>
        <h2>{tab.label}</h2>
        <p>{error}</p>
        <button className="ss-btn" onClick={reload}>reload plugin</button>
      </div>
    )
  }

  if (!resolved?.ok) {
    return (
      <div className="plugin-tab-host plugin-tab-loading" style={{ padding: 20 }}>
        loading plugin…
      </div>
    )
  }

  return (
    <div className="plugin-tab-host" style={{ width: '100%', height: '100%', minHeight: 0, position: 'relative' }}>
      {workspace?.kind === 'remote' && (
        <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 2, maxWidth: 460, padding: 10, border: '1px solid #1c2f2f', background: 'rgba(15, 18, 15, 0.92)', color: '#c7d8d4', fontFamily: 'var(--font-family-mono)', fontSize: 11 }}>
          remote workspace: plugin file capabilities are local-only in v0 until safe remote routes exist.
        </div>
      )}
      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 2, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        {runtimeErrors.length > 0 && (
          <div style={{ maxWidth: 420, padding: 10, border: '1px solid #7f1d1d', background: 'rgba(69, 10, 10, 0.92)', color: '#fecaca', fontFamily: 'var(--font-family-mono)', fontSize: 11, whiteSpace: 'pre-wrap' }}>
            <div style={{ color: '#fff', marginBottom: 6 }}>plugin error</div>
            {runtimeErrors[0]}
          </div>
        )}
        <button className="ss-btn" onClick={reload}>reload</button>
      </div>
      {/* Plugin UI is isolated from the trusted renderer. allow-same-origin is
          needed so crewcode-plugin:// panels can load their own scripts/styles. */}
      <iframe
        ref={iframeRef}
        key={`${resolved.url}:${reloadNonce}`}
        title={resolved.title}
        name={iframeName}
        src={resolved.url}
        sandbox={PLUGIN_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        onLoad={postContext}
        style={{ width: '100%', height: '100%', border: 0, display: 'block', background: '#0f120f' }}
      />
    </div>
  )
}
