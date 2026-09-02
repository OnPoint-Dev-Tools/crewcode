import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { TranscriptService } from './transcript-service'

describe('TranscriptService', () => {
  it('persists, reloads, timestamps, and removes transcript shards', () => {
    const root = mkdtempSync(join(tmpdir(), 'crewcode-transcripts-'))
    const first = new TranscriptService(root)
    expect(first.save('workspace::chat', [{ kind: 'user', text: 'hello' }])).toEqual({ ok: true })
    expect(first.mtimes()['workspace::chat']).toBeGreaterThan(0)

    const restored = new TranscriptService(root)
    expect(restored.loadAll()).toEqual({ 'workspace::chat': [{ kind: 'user', text: 'hello' }] })
    expect(restored.remove('workspace::chat')).toEqual({ ok: true })
    expect(restored.loadAll()).toEqual({})
  })

  it('ignores malformed batch entries and normalizes messages', () => {
    const service = new TranscriptService(mkdtempSync(join(tmpdir(), 'crewcode-transcripts-')))
    service.saveBatch([
      { scopeId: 'one', messages: [{ text: 'kept' }, null, 'drop'] as unknown[] },
      { scopeId: '', messages: [{ text: 'drop' }] },
    ])
    expect(service.loadAll()).toEqual({ one: [{ text: 'kept' }] })
  })

  it('merges divergent full-array saves without erasing another client turn', () => {
    const service = new TranscriptService(mkdtempSync(join(tmpdir(), 'crewcode-transcripts-')))
    const initial = { id: 'initial', kind: 'user', text: 'Start the task' }
    service.save('shared-thread', [initial, { id: 'desktop-turn', kind: 'assistant', text: 'Desktop result' }])

    // The browser save was formed from the same initial snapshot and did not
    // yet observe the desktop result.
    service.save('shared-thread', [initial, { id: 'web-turn', kind: 'user', text: 'Web follow-up' }])

    expect(service.loadAll()['shared-thread']).toEqual([
      initial,
      { id: 'desktop-turn', kind: 'assistant', text: 'Desktop result' },
      { id: 'web-turn', kind: 'user', text: 'Web follow-up' },
    ])
  })

  it('replaces a stable message identity instead of duplicating status updates', () => {
    const service = new TranscriptService(mkdtempSync(join(tmpdir(), 'crewcode-transcripts-')))
    service.save('shared-thread', [{ id: 'activity-one', kind: 'activity', status: 'running' }])
    service.save('shared-thread', [{ id: 'activity-one', kind: 'activity', status: 'completed' }])

    expect(service.loadAll()['shared-thread']).toEqual([
      { id: 'activity-one', kind: 'activity', status: 'completed' },
    ])
  })

  it('deduplicates the same renderer row when client display clocks differ', () => {
    const service = new TranscriptService(mkdtempSync(join(tmpdir(), 'crewcode-transcripts-')))
    service.save('shared-thread', [{ kind: 'user', text: 'Continue this work', time: '4:10 PM' }])
    service.save('shared-thread', [{ kind: 'user', text: 'Continue this work', time: '1:10 PM' }])

    expect(service.loadAll()['shared-thread']).toEqual([
      { kind: 'user', text: 'Continue this work', time: '1:10 PM' },
    ])
  })

  it('loads one bounded recent scope without aggregating the transcript store', () => {
    const service = new TranscriptService(mkdtempSync(join(tmpdir(), 'crewcode-transcripts-')))
    service.save('large-thread', [
      { id: 'old', kind: 'user', text: 'older history remains authoritative' },
      { id: 'oversize', kind: 'toolcall', result: 'x'.repeat(600 * 1024) },
      { id: 'new', kind: 'assistant', text: 'recent history crosses the relay' },
    ])
    service.save('unrelated-thread', [{ kind: 'user', text: 'do not aggregate me' }])

    const scoped = service.loadScope('large-thread')
    expect(Buffer.byteLength(JSON.stringify(scoped))).toBeLessThanOrEqual(96 * 1024)
    expect(scoped).toEqual([
      { id: 'old', kind: 'user', text: 'older history remains authoritative' },
      { id: 'new', kind: 'assistant', text: 'recent history crosses the relay' },
    ])
    expect(service.loadAll()['large-thread']).toHaveLength(3)
  })

  it('keeps a full 32-scope startup hydration below the relay burst budget', () => {
    const service = new TranscriptService(mkdtempSync(join(tmpdir(), 'crewcode-transcripts-')))
    const responses: unknown[] = []
    for (let index = 0; index < 32; index += 1) {
      const scopeId = `startup-${index}`
      service.save(scopeId, Array.from({ length: 40 }, (_, message) => ({
        id: `${scopeId}-${message}`,
        kind: 'assistant',
        text: 'x'.repeat(16 * 1024),
      })))
      responses.push(service.loadScope(scopeId))
    }

    const totalBytes = responses.reduce<number>((total, response) => total + Buffer.byteLength(JSON.stringify(response)), 0)
    expect(totalBytes).toBeLessThanOrEqual(3 * 1024 * 1024)
    expect(service.loadAll()['startup-0']).toHaveLength(40)
  })

  it('returns bounded recent thread metadata without transcript bodies', () => {
    const service = new TranscriptService(mkdtempSync(join(tmpdir(), 'crewcode-transcripts-')))
    service.save('thread-one', [
      { kind: 'user', text: 'Build the mobile machine dashboard' },
      { kind: 'assistant', text: 'A private response that must not be returned.' },
    ])
    service.save('thread-two', [{ role: 'user', content: 'Review the Hub relay' }])

    const recent = service.recent(2)
    expect(recent).toHaveLength(2)
    expect(recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: 'thread-one', firstUserText: 'Build the mobile machine dashboard' }),
      expect.objectContaining({ scopeId: 'thread-two', firstUserText: 'Review the Hub relay' }),
    ]))
    expect(JSON.stringify(recent)).not.toContain('private response')
    expect(service.recent(1)).toHaveLength(1)
    expect(service.recent(0)).toEqual([])
  })

  it('catalogues scope metadata without returning transcript bodies', async () => {
    const service = new TranscriptService(mkdtempSync(join(tmpdir(), 'crewcode-transcripts-')))
    service.save('workspace-chat', [{ kind: 'user', text: 'please fix the recovered chat drawer order now' }])

    const catalogue = await service.catalogue()
    expect(catalogue).toEqual([
      expect.objectContaining({
        scopeId: 'workspace-chat',
        updatedAt: expect.any(Number),
        titleHint: 'fix recovered chat drawer',
      }),
    ])
    expect(JSON.stringify(catalogue)).not.toContain('please fix the recovered chat drawer order now')
  })
})
