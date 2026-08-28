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
})
