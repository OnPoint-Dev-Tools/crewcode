import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, renderHook } from './hook-test-host'
import { migratePersistedSessions, useChatSessions } from './useChatSessions'

describe('chat session mode migration', () => {
  it('maps the legacy yolo mode to full', () => {
    // 'yolo' was renamed to 'full'. Leaving it in place resolves to no entry in
    // MODE_FROM_SETTINGS, which crashes the composer's mode picker.
    const sessions = {
      tab: [{
        id: 'tab', tabId: 'tab', label: 'Session', agentId: 'claude', model: '',
        mode: 'yolo' as never, effort: 'high' as const, mcpServerIds: [],
      }],
    }

    expect(migratePersistedSessions(sessions).tab?.[0]?.mode).toBe('full')
  })

  it('falls back to build for an unknown persisted mode', () => {
    const sessions = {
      tab: [{
        id: 'tab', tabId: 'tab', label: 'Session', agentId: 'claude', model: '',
        mode: 'nonsense' as never, effort: 'high' as const, mcpServerIds: [],
      }],
    }

    expect(migratePersistedSessions(sessions).tab?.[0]?.mode).toBe('build')
  })

  it('normalizes an invalid persisted CrewCoder mode independently', () => {
    const sessions = {
      tab: [{
        id: 'tab', tabId: 'tab', label: 'Session', agentId: 'crewcoder', model: '',
        mode: 'plan' as const, crewcoderMode: 'auto' as never, effort: 'high' as const, mcpServerIds: [],
      }],
    }

    const migrated = migratePersistedSessions(sessions)
    expect(migrated.tab[0].mode).toBe('build')
    expect(migrated.tab[0].crewcoderMode).toBe('general')
    expect(migrated.tab[0].crewcoderApprovalMode).toBe('review')
  })

  it('preserves explicit CrewCoder full access and fails invalid approval state closed', () => {
    const base = {
      id: 'tab', tabId: 'tab', label: 'Session', agentId: 'crewcoder', model: '',
      mode: 'build' as const, crewcoderMode: 'crewcoder' as const, effort: 'high' as const, mcpServerIds: [],
    }
    expect(migratePersistedSessions({ tab: [{ ...base, crewcoderApprovalMode: 'full-access' as const }] }).tab[0].crewcoderApprovalMode).toBe('full-access')
    expect(migratePersistedSessions({ tab: [{ ...base, crewcoderApprovalMode: 'invalid' as never }] }).tab[0].crewcoderApprovalMode).toBe('review')
  })

  it('preserves normal execution modes when CrewCoder uses its configured default', () => {
    const sessions = {
      tab: [{
        id: 'tab', tabId: 'tab', label: 'Session', agentId: 'crewcoder', model: '',
        mode: 'plan' as const, effort: 'high' as const, mcpServerIds: [],
      }],
    }

    expect(migratePersistedSessions(sessions).tab[0].mode).toBe('plan')
  })
})

describe('chat session effort migration', () => {
  it('maps the legacy minimal id to low', () => {
    const sessions = {
      tab: [{
        id: 'tab', tabId: 'tab', label: 'Session', agentId: 'codex', model: '',
        mode: 'build' as const, effort: 'minimal' as const, mcpServerIds: [],
      }],
    }

    const migrated = migratePersistedSessions(sessions)

    expect(migrated.tab?.[0]?.effort).toBe('low')
    expect(migrated.tab?.[0]?.enabledSkillIds).toEqual([])
  })

  it('defaults legacy sessions to CrewCode mode prompts enabled', () => {
    const sessions = {
      tab: [{
        id: 'tab', tabId: 'tab', label: 'Session', agentId: 'claude', model: '',
        mode: 'build' as const, effort: 'high' as const, mcpServerIds: [],
      }],
    }

    expect(migratePersistedSessions(sessions).tab[0].modePromptsEnabled).toBe(true)
  })

  it('preserves current effort values', () => {
    const sessions = {
      tab: [{
        id: 'tab', tabId: 'tab', label: 'Session', agentId: 'claude', model: '',
        mode: 'build' as const, effort: 'max' as const, mcpServerIds: [],
      }],
    }

    expect(migratePersistedSessions(sessions)).toEqual({
      tab: [{ ...sessions.tab[0], enabledSkillIds: [], modePromptsEnabled: true }],
    })
  })

  it('preserves session-scoped skill activation', () => {
    const sessions = {
      tab: [{
        id: 'tab', tabId: 'tab', label: 'Session', agentId: 'claude', model: '',
        mode: 'build' as const, effort: 'high' as const, mcpServerIds: [],
        enabledSkillIds: ['review'],
      }],
    }

    expect(migratePersistedSessions(sessions).tab[0].enabledSkillIds).toEqual(['review'])
  })
})

describe('chat session skill isolation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps active skills on the selected solo session', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
    const hook = renderHook(() => useChatSessions({
      agentId: 'codex',
      model: '',
      mode: 'build',
      effort: 'medium',
    }), undefined)

    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => { hook.result.current.ensureTab('chat-b', 'Project') })
    act(() => {
      hook.result.current.update('chat-a', 'chat-a', { enabledSkillIds: ['review'] })
    })

    expect(hook.result.current.getActiveSession('chat-a')?.enabledSkillIds).toEqual(['review'])
    expect(hook.result.current.getActiveSession('chat-b')?.enabledSkillIds).toEqual([])

    hook.unmount()
  })

  it('copies mode prompt enablement when duplicating a session', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
    const hook = renderHook(() => useChatSessions({
      agentId: 'codex', model: '', mode: 'build', effort: 'medium',
    }), undefined)

    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => {
      hook.result.current.update('chat-a', 'chat-a', { modePromptsEnabled: false })
    })
    act(() => { hook.result.current.duplicate('chat-a', 'chat-a') })

    const copy = hook.result.current.getSessions('chat-a').find(session => session.id !== 'chat-a')
    expect(copy?.modePromptsEnabled).toBe(false)
    hook.unmount()
  })
})

describe('new chat default branch', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('captures the current default branch only on newly created sessions', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
    let initialBranch = 'dev'
    const hook = renderHook(() => useChatSessions({
      agentId: 'codex', model: '', mode: 'build', effort: 'medium', initialBranch,
    }), undefined)

    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    expect(hook.result.current.getActiveSession('chat-a')?.initialBranch).toBe('dev')

    initialBranch = 'release'
    hook.rerender(undefined)
    act(() => { hook.result.current.add('chat-a', 'Second') })
    const sessions = hook.result.current.getSessions('chat-a')
    expect(sessions[0]?.initialBranch).toBe('dev')
    expect(sessions[1]?.initialBranch).toBe('release')
    hook.unmount()
  })
})

describe('chat session pinning', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function host() {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
    return { data, hook: renderHook(() => useChatSessions({
      agentId: 'codex', model: '', mode: 'build', effort: 'medium',
    }), undefined) }
  }

  it('persists pin state on the session', () => {
    const { data, hook } = host()
    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => { hook.result.current.update('chat-a', 'chat-a', { pinned: true }) })

    expect(hook.result.current.getActiveSession('chat-a')?.pinned).toBe(true)
    const stored = JSON.parse(data.get('crewcode:sessionsByTab') ?? '{}')
    expect(stored['chat-a'][0].pinned).toBe(true)
    hook.unmount()
  })

  it('starts duplicated sessions unpinned', () => {
    const { hook } = host()
    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => { hook.result.current.update('chat-a', 'chat-a', { pinned: true }) })

    act(() => { hook.result.current.duplicate('chat-a', 'chat-a') })

    const copy = hook.result.current.getSessions('chat-a').find(session => session.id !== 'chat-a')
    expect(copy?.pinned).toBeUndefined()
    hook.unmount()
  })
})

describe('chat session archiving', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function host() {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
    return renderHook(() => useChatSessions({
      agentId: 'codex', model: '', mode: 'build', effort: 'medium',
    }), undefined)
  }

  it('hides archived sessions from the live list but keeps the record', () => {
    const hook = host()
    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => { hook.result.current.add('chat-a') })

    act(() => { hook.result.current.setArchived('chat-a', 'chat-a::s2', true) })

    expect(hook.result.current.getSessions('chat-a').map(s => s.id)).toEqual(['chat-a'])
    expect(hook.result.current.getAllSessions('chat-a')).toHaveLength(2)
    hook.unmount()
  })

  it('moves activation off an archived session and back on restore', () => {
    const hook = host()
    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => { hook.result.current.add('chat-a') })
    expect(hook.result.current.getActiveId('chat-a')).toBe('chat-a::s2')

    act(() => { hook.result.current.setArchived('chat-a', 'chat-a::s2', true) })
    expect(hook.result.current.getActiveId('chat-a')).toBe('chat-a')

    act(() => { hook.result.current.setArchived('chat-a', 'chat-a::s2', false) })
    expect(hook.result.current.getActiveId('chat-a')).toBe('chat-a::s2')
    hook.unmount()
  })

  it('seeds a fresh thread when every session in a tab is archived', () => {
    const hook = host()
    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => { hook.result.current.setArchived('chat-a', 'chat-a', true) })
    expect(hook.result.current.getSessions('chat-a')).toEqual([])

    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })

    const live = hook.result.current.getSessions('chat-a')
    expect(live).toHaveLength(1)
    // Must not reuse the archived session's id — that would alias transcripts.
    expect(live[0].id).not.toBe('chat-a')
    expect(hook.result.current.getAllSessions('chat-a')).toHaveLength(2)
    hook.unmount()
  })

  it('stamps archivedAt on archive and clears it on restore', () => {
    const hook = host()
    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => { hook.result.current.add('chat-a') })

    act(() => { hook.result.current.setArchived('chat-a', 'chat-a::s2', true) })
    const archived = hook.result.current.getAllSessions('chat-a').find(s => s.id === 'chat-a::s2')
    expect(typeof archived?.archivedAt).toBe('number')

    act(() => { hook.result.current.setArchived('chat-a', 'chat-a::s2', false) })
    const restored = hook.result.current.getAllSessions('chat-a').find(s => s.id === 'chat-a::s2')
    // A re-archive must get a fresh window, not inherit the old clock.
    expect(restored?.archivedAt).toBeUndefined()
    hook.unmount()
  })

  it('records creation and last-used separately from archive time', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1_000)
    const hook = host()
    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })

    expect(hook.result.current.getActiveSession('chat-a')).toMatchObject({
      createdAt: 1_000,
      lastUsedAt: 1_000,
    })

    act(() => { hook.result.current.touchLastUsed('chat-a', 'chat-a', 2_000) })
    now.mockReturnValue(3_000)
    act(() => { hook.result.current.setArchived('chat-a', 'chat-a', true) })

    expect(hook.result.current.getAllSessions('chat-a')[0]).toMatchObject({
      createdAt: 1_000,
      lastUsedAt: 2_000,
      archivedAt: 3_000,
    })
    now.mockRestore()
    hook.unmount()
  })

  it('backfills legacy timestamps from transcript activity', () => {
    const data = new Map<string, string>()
    data.set('crewcode:sessionsByTab', JSON.stringify({
      'chat-a': [
        { id: 'chat-a', tabId: 'chat-a', label: 'Legacy', agentId: 'claude', model: '', mode: 'build', effort: 'high', mcpServerIds: [], enabledSkillIds: [] },
      ],
    }))
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
    const hook = renderHook(() => useChatSessions({
      agentId: 'codex', model: '', mode: 'build', effort: 'medium',
    }), undefined)

    act(() => { hook.result.current.backfillSessionTimestamps({ 'chat-a': 8_000 }) })

    expect(hook.result.current.getActiveSession('chat-a')).toMatchObject({
      createdAt: 8_000,
      lastUsedAt: 8_000,
    })
    hook.unmount()
  })

  it('backfills archivedAt for sessions archived before the field existed', () => {
    const data = new Map<string, string>()
    data.set('crewcode:sessionsByTab', JSON.stringify({
      'chat-a': [
        { id: 'chat-a', tabId: 'chat-a', label: 'Live', agentId: 'claude', model: '', mode: 'build', effort: 'high', mcpServerIds: [], enabledSkillIds: [] },
        { id: 'chat-a::s2', tabId: 'chat-a', label: 'Old', agentId: 'claude', model: '', mode: 'build', effort: 'high', mcpServerIds: [], enabledSkillIds: [], archived: true },
      ],
    }))
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
    const hook = renderHook(() => useChatSessions({
      agentId: 'codex', model: '', mode: 'build', effort: 'medium',
    }), undefined)

    expect(hook.result.current.getAllSessions('chat-a')[1].archivedAt).toBeUndefined()
    act(() => { hook.result.current.backfillArchivedAt() })

    const list = hook.result.current.getAllSessions('chat-a')
    expect(typeof list[1].archivedAt).toBe('number')
    // Live sessions must not be touched.
    expect(list[0].archivedAt).toBeUndefined()
    hook.unmount()
  })

  it('refuses to delete the last live session but always deletes archived ones', () => {
    const hook = host()
    act(() => { hook.result.current.ensureTab('chat-a', 'Project') })
    act(() => { hook.result.current.add('chat-a') })
    act(() => { hook.result.current.setArchived('chat-a', 'chat-a::s2', true) })

    let live: { removed: boolean } = { removed: true }
    act(() => { live = hook.result.current.remove('chat-a', 'chat-a') })
    expect(live.removed).toBe(false)

    let archived: { removed: boolean } = { removed: false }
    act(() => { archived = hook.result.current.remove('chat-a', 'chat-a::s2') })
    expect(archived.removed).toBe(true)
    expect(hook.result.current.getAllSessions('chat-a')).toHaveLength(1)
    hook.unmount()
  })

  it('restores an exact remote transcript id without aliasing its messages', () => {
    const hook = host()
    act(() => {
      hook.result.current.restoreRemote({
        id: 'project-chat::s4',
        tabId: 'project-chat',
        label: 'Mobile dashboard',
        agentId: 'claude',
      })
    })

    expect(hook.result.current.getActiveId('project-chat')).toBe('project-chat::s4')
    expect(hook.result.current.getAllSessions('project-chat')).toEqual([
      expect.objectContaining({
        id: 'project-chat::s4',
        tabId: 'project-chat',
        label: 'Mobile dashboard',
        agentId: 'claude',
      }),
    ])
    let conflict: unknown = 'not called'
    act(() => {
      conflict = hook.result.current.restoreRemote({ id: 'project-chat::s4', tabId: 'other-chat', label: 'Duplicate' })
    })
    expect(conflict).toBeNull()
    expect(hook.result.current.getAllSessions('project-chat')).toHaveLength(1)
    hook.unmount()
  })
})
