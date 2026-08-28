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
    expect(card).toContain('>Chats <span>{targetSessions.length}</span></button>')
    expect(card).toContain("destinationTab === 'used'")
    expect(card).toContain('targetSessions.map(session =>')
    expect(styles).toContain('.handoff-card-tabs {')
  })

  it('uses the workspace Sessions catalogue and the destination owner tab', () => {
    expect(pane).toContain('sessions={workspaceSessions}')
    expect(pane).toContain('workspaceSessions.find(session => session.id === selection.targetSessionId)')
    expect(pane).toContain('chatSessions.activate(target.tabId, target.id)')
    expect(pane).toContain('const targetPath = resolveHandoffSessionPath(target)')
  })

  it('closes the card as soon as either destination transfer starts', () => {
    expect(pane).toContain('setHandoffBusy(true)\n    setHandoffError(null)\n    setHandoffOpen(false)')
    expect(pane).not.toContain('if (result.ok) setHandoffOpen(false)')
    expect(pane).toContain("message: result.ok ? 'handoff complete' : (result.error ?? 'handoff failed')")
  })

  it('requires a selected used chat before enabling handoff', () => {
    expect(card).toContain("destinationTab === 'new' || !!selectedExisting")
    expect(card).toContain("destinationTab === 'new' ? 'new' : selectedExisting!.id")
  })
})
