import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_CATALOGUE_AUTHORITY_KEY, DESKTOP_CATALOGUE_AUTHORITY_VALUE } from '../../../shared/continuity-state-types'

const storage = new Map<string, string>()
const continuityStateGet = vi.fn()
const continuityStateUpdate = vi.fn()
const continuityDesktopSeed = vi.fn()
const workspacesList = vi.fn()
const transcriptsCatalogue = vi.fn()
let runtimeKind: 'web' | 'brain' = 'web'

vi.mock('./crewcode-client', () => ({
  getCrewCodeRuntime: () => ({
    kind: runtimeKind,
    client: { continuityStateGet, continuityStateUpdate, continuityDesktopSeed, workspacesList, transcriptsCatalogue },
  }),
}))

describe('continuity catalogue hydration', () => {
  beforeEach(() => {
    storage.clear()
    continuityStateGet.mockReset()
    continuityStateUpdate.mockReset()
    continuityDesktopSeed.mockReset()
    workspacesList.mockReset()
    transcriptsCatalogue.mockReset()
    runtimeKind = 'web'
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
    vi.stubGlobal('window', {
      setInterval: () => 0,
      addEventListener: () => undefined,
    })
  })

  it('hydrates allowlisted Brain catalogue keys before React mounts', async () => {
    continuityStateGet.mockResolvedValue({
      version: 1,
      revision: 4,
      updatedAt: 1,
      values: {
        'crewcode:activeWorkspaceId': 'workspace-one',
        'crewcode:ignored': 'drop-me',
      },
    })
    const { hydrateContinuityState } = await import('./continuity-state')
    await hydrateContinuityState()
    expect(storage.get('crewcode:activeWorkspaceId')).toBe('workspace-one')
    expect(storage.has('crewcode:ignored')).toBe(false)
    expect(continuityStateUpdate).not.toHaveBeenCalled()
  })

  it('does not synthesize transcript rows after desktop catalogue authority is established', async () => {
    continuityStateGet.mockResolvedValue({
      version: 1,
      revision: 5,
      updatedAt: 1,
      values: {
        [DESKTOP_CATALOGUE_AUTHORITY_KEY]: DESKTOP_CATALOGUE_AUTHORITY_VALUE,
        'crewcode:sessionsByTab': JSON.stringify({
          'workspace-chat': [{ id: 'workspace-chat', label: 'Exact desktop chat' }],
        }),
      },
    })
    const { hydrateContinuityState } = await import('./continuity-state')
    await hydrateContinuityState()

    expect(transcriptsCatalogue).not.toHaveBeenCalled()
    expect(JSON.parse(storage.get('crewcode:sessionsByTab') ?? '{}')).toEqual({
      'workspace-chat': [{ id: 'workspace-chat', label: 'Exact desktop chat' }],
    })
    expect(continuityStateUpdate).not.toHaveBeenCalled()
  })

  it('keeps transcript recovery available for standalone web and non-desktop Brain modes', async () => {
    continuityStateGet.mockResolvedValue({ version: 1, revision: 0, updatedAt: 0, values: {} })
    workspacesList.mockResolvedValue([{ id: 'workspace', name: 'Workspace' }])
    transcriptsCatalogue.mockResolvedValue([{ scopeId: 'workspace-chat', updatedAt: 100 }])

    const { hydrateContinuityState } = await import('./continuity-state')
    await hydrateContinuityState()

    expect(transcriptsCatalogue).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.get('crewcode:sessionsByTab') ?? '{}')).toEqual({
      'workspace-chat': [expect.objectContaining({ id: 'workspace-chat', continuityRecovered: true })],
    })
    expect(continuityDesktopSeed).not.toHaveBeenCalled()
    expect(continuityStateUpdate).not.toHaveBeenCalled()
  })

  it('establishes catalogue authority through desktop-only seed control', async () => {
    runtimeKind = 'brain'
    storage.set('crewcode:sessionsByTab', JSON.stringify({
      'workspace-chat': [{ id: 'workspace-chat', label: 'Exact desktop chat', createdAt: 10 }],
    }))
    continuityStateGet.mockResolvedValue({
      version: 1,
      revision: 5,
      updatedAt: 1,
      values: {
        'crewcode:sessionsByTab': JSON.stringify({
          'workspace-chat': [{ id: 'workspace-chat', label: 'Recovered chat · 2026-08-31', createdAt: 10.5 }],
        }),
      },
    })
    continuityDesktopSeed.mockImplementation(async (patch: Record<string, string>) => ({
      version: 1,
      revision: 6,
      updatedAt: 2,
      values: { ...patch, [DESKTOP_CATALOGUE_AUTHORITY_KEY]: DESKTOP_CATALOGUE_AUTHORITY_VALUE },
    }))

    const { hydrateContinuityState } = await import('./continuity-state')
    await hydrateContinuityState()

    expect(continuityDesktopSeed).toHaveBeenCalledWith({
      'crewcode:sessionsByTab': expect.stringContaining('Exact desktop chat'),
    })
    expect(continuityStateUpdate).not.toHaveBeenCalled()
    expect(transcriptsCatalogue).not.toHaveBeenCalled()
  })

  it('merges desktop-only sessions without replacing Brain-owned identities', async () => {
    const { mergeAttachedDesktopCatalogue } = await import('./continuity-state')
    const merged = mergeAttachedDesktopCatalogue({
      [DESKTOP_CATALOGUE_AUTHORITY_KEY]: DESKTOP_CATALOGUE_AUTHORITY_VALUE,
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat': [{ id: 'shared', tabId: 'workspace-chat', label: 'Brain label' }],
      }),
    }, {
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat': [
          { id: 'shared', tabId: 'workspace-chat', label: 'stale desktop label' },
          { id: 'desktop-only', tabId: 'workspace-chat', label: 'Desktop-only chat' },
        ],
      }),
    })

    expect(JSON.parse(merged['crewcode:sessionsByTab'])).toEqual({
      'workspace-chat': [
        { id: 'shared', tabId: 'workspace-chat', label: 'Brain label' },
        { id: 'desktop-only', tabId: 'workspace-chat', label: 'Desktop-only chat' },
      ],
    })
  })

  it('keeps the newest completion stamp when merging desktop and Brain elapsed maps', async () => {
    const { mergeAttachedDesktopCatalogue } = await import('./continuity-state')
    const merged = mergeAttachedDesktopCatalogue({
      'crewcode:sessionCompletedAt:v1': JSON.stringify({ shared: 10, brainOnly: 30 }),
    }, {
      'crewcode:sessionCompletedAt:v1': JSON.stringify({ shared: 40, desktopOnly: 20 }),
    })
    expect(JSON.parse(merged['crewcode:sessionCompletedAt:v1'])).toEqual({
      shared: 40,
      brainOnly: 30,
      desktopOnly: 20,
    })
  })

  it('uses exact desktop names and order until catalogue authority exists', async () => {
    const { mergeAttachedDesktopCatalogue } = await import('./continuity-state')
    const merged = mergeAttachedDesktopCatalogue({
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat': [
          { id: 'workspace-chat::s2', tabId: 'workspace-chat', label: 'Wrong web label', createdAt: 20 },
          { id: 'workspace-chat', tabId: 'workspace-chat', label: 'Also wrong', createdAt: 10 },
        ],
      }),
    }, {
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat': [
          { id: 'workspace-chat', tabId: 'workspace-chat', label: 'First desktop chat', createdAt: 10 },
          { id: 'workspace-chat::s2', tabId: 'workspace-chat', label: 'Second desktop chat', createdAt: 20 },
        ],
      }),
    })

    expect(JSON.parse(merged['crewcode:sessionsByTab'])).toEqual({
      'workspace-chat': [
        { id: 'workspace-chat', tabId: 'workspace-chat', label: 'First desktop chat', createdAt: 10 },
        { id: 'workspace-chat::s2', tabId: 'workspace-chat', label: 'Second desktop chat', createdAt: 20 },
      ],
    })
  })

  it('repairs a legacy recovered Brain catalogue from exact desktop rows and order', async () => {
    const { mergeAttachedDesktopCatalogue } = await import('./continuity-state')
    const merged = mergeAttachedDesktopCatalogue({
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat-new': [{ id: 'workspace-chat-new', tabId: 'workspace-chat-new', label: 'Recovered chat · 2026-08-31', createdAt: 100.5 }],
        'workspace-chat': [{ id: 'workspace-chat', tabId: 'workspace-chat', label: 'Recovered chat · 2026-08-31', createdAt: 90.5 }],
        'web-created-chat': [{ id: 'web-created-chat', tabId: 'web-created-chat', label: 'Created on web', createdAt: 110 }],
      }),
      'crewcode:activeSessionByTab': JSON.stringify({
        'workspace-chat-new': 'workspace-chat-new',
        'workspace-chat': 'workspace-chat',
        'web-created-chat': 'web-created-chat',
      }),
    }, {
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat': [{ id: 'workspace-chat', tabId: 'workspace-chat', label: 'Original first chat', createdAt: 10 }],
        'workspace-chat-new': [{ id: 'workspace-chat-new', tabId: 'workspace-chat-new', label: 'Original second chat', createdAt: 20 }],
      }),
      'crewcode:activeSessionByTab': JSON.stringify({ 'workspace-chat-new': 'workspace-chat-new' }),
    })

    expect(JSON.parse(merged['crewcode:sessionsByTab'])).toEqual({
      'workspace-chat': [{ id: 'workspace-chat', tabId: 'workspace-chat', label: 'Original first chat', createdAt: 10 }],
      'workspace-chat-new': [{ id: 'workspace-chat-new', tabId: 'workspace-chat-new', label: 'Original second chat', createdAt: 20 }],
      'web-created-chat': [{ id: 'web-created-chat', tabId: 'web-created-chat', label: 'Created on web', createdAt: 110 }],
    })
    expect(JSON.parse(merged['crewcode:activeSessionByTab'])).toEqual({
      'workspace-chat-new': 'workspace-chat-new',
      'web-created-chat': 'web-created-chat',
    })
  })

  it('recovers missing workspace chat sessions from transcript metadata only', async () => {
    const { recoverTranscriptSessions } = await import('./continuity-state')
    const recovered = recoverTranscriptSessions({}, [{ id: 'workspace', name: 'Workspace' }], [
      { scopeId: 'workspace-chat', updatedAt: 100, agentId: 'codex', model: 'gpt-5.6-sol' },
      { scopeId: 'workspace-chat::s2', updatedAt: 200, agentId: 'claude' },
      { scopeId: 'crew/lane-one', updatedAt: 300 },
      { scopeId: 'unregistered-chat', updatedAt: 400 },
    ])
    const sessions = JSON.parse(recovered['crewcode:sessionsByTab'])
    expect(sessions['workspace-chat']).toEqual([
      expect.objectContaining({ id: 'workspace-chat', tabId: 'workspace-chat', agentId: 'codex', model: 'gpt-5.6-sol', continuityRecovered: true }),
      expect.objectContaining({ id: 'workspace-chat::s2', tabId: 'workspace-chat', agentId: 'claude', continuityRecovered: true }),
    ])
    expect(JSON.stringify(sessions)).not.toContain('crew/lane-one')
    expect(JSON.stringify(sessions)).not.toContain('unregistered-chat')
  })

  it('retitles persisted recovered Brain rows from transcript title hints', async () => {
    const { recoverTranscriptSessions } = await import('./continuity-state')
    const recovered = recoverTranscriptSessions({
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat': [
          { id: 'workspace-chat::s2', tabId: 'workspace-chat', label: 'Recovered chat · 2026-08-31', createdAt: 200.5 },
          { id: 'workspace-chat', tabId: 'workspace-chat', label: 'Recovered chat · 2026-08-31', createdAt: 100.5 },
        ],
      }),
    }, [{ id: 'workspace', name: 'Workspace' }], [
      { scopeId: 'workspace-chat', updatedAt: 100, titleHint: 'fix drawer order' },
      { scopeId: 'workspace-chat::s2', updatedAt: 200, titleHint: 'continue desktop chats' },
    ])
    expect(JSON.parse(recovered['crewcode:sessionsByTab'])['workspace-chat']).toEqual([
      expect.objectContaining({ id: 'workspace-chat', label: 'fix drawer order' }),
      expect.objectContaining({ id: 'workspace-chat::s2', label: 'continue desktop chats' }),
    ])
  })

  it('orders recovered tabs oldest-first so the drawer reverse matches desktop', async () => {
    const { recoverTranscriptSessions } = await import('./continuity-state')
    const recovered = recoverTranscriptSessions({
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat-mthkwkth-4': [{ id: 'workspace-chat-mthkwkth-4', tabId: 'workspace-chat-mthkwkth-4', label: 'Newest extra chat', createdAt: 300 }],
        'workspace-chat-mqwmxqm7-1': [{ id: 'workspace-chat-mqwmxqm7-1', tabId: 'workspace-chat-mqwmxqm7-1', label: 'Older extra chat', createdAt: 200 }],
        'workspace-chat': [{ id: 'workspace-chat', tabId: 'workspace-chat', label: 'Original chat', createdAt: 100 }],
      }),
    }, [{ id: 'workspace', name: 'Workspace' }], [])
    expect(Object.keys(JSON.parse(recovered['crewcode:sessionsByTab']))).toEqual([
      'workspace-chat',
      'workspace-chat-mqwmxqm7-1',
      'workspace-chat-mthkwkth-4',
    ])
  })

  it('stores recovered sessions oldest-first so the drawer reverse matches desktop', async () => {
    const { recoverTranscriptSessions } = await import('./continuity-state')
    const recovered = recoverTranscriptSessions({}, [{ id: 'workspace', name: 'Workspace' }], [
      { scopeId: 'workspace-chat::s3', updatedAt: 300 },
      { scopeId: 'workspace-chat', updatedAt: 100 },
      { scopeId: 'workspace-chat::s2', updatedAt: 200 },
    ])
    expect(JSON.parse(recovered['crewcode:sessionsByTab'])['workspace-chat'].map((row: { id: string }) => row.id)).toEqual([
      'workspace-chat',
      'workspace-chat::s2',
      'workspace-chat::s3',
    ])
  })

  it('strips fallback rows before browser catalogue updates reach Brain', async () => {
    const { stripRecoveredCatalogue } = await import('./continuity-state')
    const clean = stripRecoveredCatalogue({
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat': [
          { id: 'workspace-chat', continuityRecovered: true },
          { id: 'workspace-chat::s2', label: 'Continued on web' },
        ],
        'fallback-only': [{ id: 'fallback-only', continuityRecovered: true }],
      }),
      'crewcode:activeSessionByTab': JSON.stringify({
        'workspace-chat': 'workspace-chat::s2',
        'fallback-only': 'fallback-only',
      }),
    })

    expect(JSON.parse(clean['crewcode:sessionsByTab'])).toEqual({
      'workspace-chat': [{ id: 'workspace-chat::s2', label: 'Continued on web' }],
    })
    expect(JSON.parse(clean['crewcode:activeSessionByTab'])).toEqual({
      'workspace-chat': 'workspace-chat::s2',
    })
  })

  it('does not push recovered-only catalogues back to Brain', async () => {
    const { stripRecoveredCatalogue } = await import('./continuity-state')
    const clean = stripRecoveredCatalogue({
      'crewcode:sessionsByTab': JSON.stringify({
        'workspace-chat': [{ id: 'workspace-chat', label: 'Recovered chat · 2026-08-31', createdAt: 10.5 }],
      }),
      'crewcode:activeSessionByTab': JSON.stringify({ 'workspace-chat': 'workspace-chat' }),
    })
    expect(clean['crewcode:sessionsByTab']).toBeUndefined()
    expect(clean['crewcode:activeSessionByTab']).toBeUndefined()
  })
})
