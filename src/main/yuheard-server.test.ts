/**
 * Tests for the YuHeard server. We test `processLine` and
 * `reportYuHeardFromProcess` directly — the live socket listener is a
 * thin wrapper around them, and starting the real `net.createServer`
 * in a unit test would require mocking Electron's `BrowserWindow`.
 */

import { describe, it, expect, vi } from 'vitest'
import { YuHeardServer, type YuHeardPaneRegistry } from './yuheard-server'

function makeRegistry(panes: Record<string, { cwd?: string; agentId?: string | null; createdAt?: number; yuheard?: boolean }> = {}): YuHeardPaneRegistry {
  return {
    hasPane: id => id in panes,
    getPaneCwd: id => panes[id]?.cwd,
    getPaneAgentId: id => panes[id]?.agentId ?? null,
    getPaneCreatedAt: id => panes[id]?.createdAt,
    listPaneIds: () => Object.keys(panes),
    isYuHeardEligible: id => panes[id]?.yuheard !== false,
  }
}

const REGISTRY = makeRegistry({
  'pn-1': { cwd: '/home/me/proj', agentId: 'claude', createdAt: 1000 },
  'pn-2': { cwd: '/home/me/proj', agentId: null, createdAt: 2000 },     // same cwd, newer
  'pn-3': { cwd: '/home/me/other', agentId: 'codex', createdAt: 3000 },
})

describe('yuheard-server.processLine', () => {
  it('rejects malformed JSON', () => {
    const emit = vi.fn()
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none' })
    expect(srv.processLine('not json')).toEqual({ ok: false, error: 'invalid-json' })
    expect(emit).not.toHaveBeenCalled()
  })

  it('rejects non-object payloads', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    expect(srv.processLine('"hi"')).toEqual({ ok: false, error: 'invalid-payload' })
  })

  it('rejects missing pane_id', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    expect(srv.processLine(JSON.stringify({ state: 'running' }))).toEqual({ ok: false, error: 'missing-pane-id' })
  })

  it('rejects invalid state', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    expect(srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'invalid' }))).toEqual({ ok: false, error: 'invalid-state' })
  })

  it('applies a running report for a known pane and emits an event', () => {
    const emit = vi.fn()
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none', now: () => 1234 })
    const r = srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'running', source: 'claude-hook', ts: 1234 }))
    expect(r).toMatchObject({ ok: true, result: 'applied' })
    expect(emit).toHaveBeenCalledWith({
      paneId: 'pn-1',
      state: 'running',
      message: null,
      source: 'claude-hook',
      at: 1234,
    })
  })

  it('passes message through to the renderer event', () => {
    const emit = vi.fn()
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none' })
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'complete', message: 'all done', ts: 1 }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ message: 'all done' }))
  })

  it('returns unknown-pane for an id the registry does not know', () => {
    const emit = vi.fn()
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none' })
    const r = srv.processLine(JSON.stringify({ pane_id: 'pn-ghost', state: 'running' }))
    expect(r).toMatchObject({ ok: false, result: 'unknown-pane' })
    expect(r.error).toBe('unknown-pane')
    expect(emit).not.toHaveBeenCalled()
  })

  it('dedupes a same-state report within the debounce window', () => {
    const emit = vi.fn()
    let now = 1000
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none', now: () => now, debounceMs: 500 })
    const r1 = srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'complete', ts: 1 }))
    expect(r1).toMatchObject({ ok: true, result: 'applied' })
    now += 200
    const r2 = srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'complete', ts: 2 }))
    expect(r2).toMatchObject({ ok: true, result: 'duplicate' })
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('allows a different state within the debounce window', () => {
    const emit = vi.fn()
    let now = 1000
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none', now: () => now, debounceMs: 500 })
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'running', ts: 1 }))
    now += 100
    const r = srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'complete', ts: 2 }))
    expect(r).toMatchObject({ ok: true, result: 'applied' })
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('allows the same state after the debounce window', () => {
    const emit = vi.fn()
    let now = 1000
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none', now: () => now, debounceMs: 500 })
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'complete', ts: 1 }))
    now += 600
    const r = srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'complete', ts: 2 }))
    expect(r).toMatchObject({ ok: true, result: 'applied' })
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('resolves pane-id-lookup by cwd, picking the most recent pane', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    const r = srv.processLine(JSON.stringify({ method: 'pane-id-lookup', cwd: '/home/me/proj' }))
    expect(r).toEqual({ ok: true, paneId: 'pn-2' })
  })

  it('returns no-pane-for-cwd when no pane matches', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    const r = srv.processLine(JSON.stringify({ method: 'pane-id-lookup', cwd: '/home/me/nope' }))
    expect(r).toEqual({ ok: false, error: 'no-pane-for-cwd' })
  })

  it('rejects pane-id-lookup without a cwd', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    const r = srv.processLine(JSON.stringify({ method: 'pane-id-lookup' }))
    expect(r).toEqual({ ok: false, error: 'missing-cwd' })
  })

  it('does not apply reports or cwd-lookup for chat sidecar panes', () => {
    const panes = {
      'chat-side': { cwd: '/home/me/proj', createdAt: 9000, yuheard: false },
      'term': { cwd: '/home/me/proj', createdAt: 1000, yuheard: true },
    }
    const registry = makeRegistry(panes)
    const emit = vi.fn()
    const srv = new YuHeardServer({ registry, emit, socketPath: '/tmp/none' })
    expect(srv.processLine(JSON.stringify({ pane_id: 'chat-side', state: 'complete', ts: 1 }))).toMatchObject({
      ok: false,
      error: 'unknown-pane',
    })
    expect(emit).not.toHaveBeenCalled()
    expect(srv.processLine(JSON.stringify({ method: 'pane-id-lookup', cwd: '/home/me/proj' }))).toEqual({
      ok: true,
      paneId: 'term',
    })
  })
})

describe('yuheard-server.process lifecycle', () => {
  it('shouldAutoComplete is true within the window after a running report', () => {
    let now = 1000
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none', now: () => now, autoCompleteWindowMs: 60_000 })
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'running', ts: 1 }))
    now += 30_000
    expect(srv.shouldAutoComplete('pn-1')).toBe(true)
  })

  it('shouldAutoComplete is false after the window expires', () => {
    let now = 1000
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none', now: () => now, autoCompleteWindowMs: 60_000 })
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'running', ts: 1 }))
    now += 70_000
    expect(srv.shouldAutoComplete('pn-1')).toBe(false)
  })

  it('shouldAutoComplete is false after a complete report clears the running record', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'running', ts: 1 }))
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'complete', ts: 2 }))
    expect(srv.shouldAutoComplete('pn-1')).toBe(false)
  })

  it('reportYuHeardFromProcess is equivalent to a socket report', () => {
    const emit = vi.fn()
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none' })
    const r = srv.reportYuHeardFromProcess({ pane_id: 'pn-1', state: 'complete', source: 'auto-wrap-exit', ts: 5 })
    expect(r).toBe('applied')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'pn-1', source: 'auto-wrap-exit' }))
  })

  it('notePaneClosed drops all per-pane state', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'running', ts: 1 }))
    expect(srv.shouldAutoComplete('pn-1')).toBe(true)
    srv.notePaneClosed('pn-1')
    expect(srv.shouldAutoComplete('pn-1')).toBe(false)
    expect(srv.isSessionActive('pn-1')).toBe(false)
  })

  it('noteSessionRunning arms idle watch without emitting', () => {
    const emit = vi.fn()
    const srv = new YuHeardServer({ registry: REGISTRY, emit, socketPath: '/tmp/none' })
    srv.notePaneSpawned('pn-2', '/home/me/proj')
    srv.noteSessionRunning('pn-2')
    expect(srv.isSessionActive('pn-2')).toBe(true)
    expect(srv.shouldAutoComplete('pn-2')).toBe(true)
    expect(emit).not.toHaveBeenCalled()
  })

  it('keeps the session active after complete so later turns can idle-notify', () => {
    const srv = new YuHeardServer({ registry: REGISTRY, emit: vi.fn(), socketPath: '/tmp/none' })
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'running', ts: 1 }))
    expect(srv.isSessionActive('pn-1')).toBe(true)
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'complete', ts: 2 }))
    expect(srv.isSessionActive('pn-1')).toBe(true)
    expect(srv.shouldAutoComplete('pn-1')).toBe(false)
  })

  it('accepts process-exit complete after the live registry has dropped the pane', () => {
    const panes: Record<string, { cwd?: string }> = { 'pn-1': { cwd: '/home/me/proj' } }
    const registry = makeRegistry(panes)
    const emit = vi.fn()
    const srv = new YuHeardServer({ registry, emit, socketPath: '/tmp/none' })
    srv.notePaneSpawned('pn-1', '/home/me/proj')
    srv.processLine(JSON.stringify({ pane_id: 'pn-1', state: 'running', ts: 1 }))
    delete panes['pn-1']
    const r = srv.reportYuHeardFromProcess({
      pane_id: 'pn-1',
      state: 'complete',
      source: 'auto-wrap-exit',
      ts: 2,
    })
    expect(r).toBe('applied')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'pn-1',
      state: 'complete',
      source: 'auto-wrap-exit',
    }))
  })
})
