import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const card = readFileSync(fileURLToPath(new URL('./HandoffCard.tsx', import.meta.url)), 'utf8')
const pane = readFileSync(fileURLToPath(new URL('./ChatPane.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')

describe('provider context handoff destination', () => {
  it('uses the main-process transcript key for the source chat', () => {
    expect(pane).toContain('bridges.handoff(started.bridgeId, `thread:${sourceSession.id}`')
    expect(pane).not.toContain('bridges.handoff(started.bridgeId, sourceSession.id,')
  })

  it('separates new and used destinations into tabs and loads used chats on demand', () => {
    expect(card).toContain("useState<'new' | 'used'>('new')")
    expect(card).toContain('role="tablist"')
    expect(card).toContain('>New chat</button>')
    expect(card).toContain('>Used chats <span>{targetSessions.length}</span></button>')
    expect(card).toContain("destinationTab === 'used'")
    expect(card).toContain('targetSessions.map(session =>')
    expect(styles).toContain('.handoff-card-tabs {')
  })

  it('requires a selected used chat before enabling handoff', () => {
    expect(card).toContain("destinationTab === 'new' || !!selectedExisting")
    expect(card).toContain("destinationTab === 'new' ? 'new' : selectedExisting!.id")
  })
})
