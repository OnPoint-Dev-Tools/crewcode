import { describe, expect, it } from 'vitest'
import { yuheardPtySpawnFlags } from './yuheard-types'

describe('yuheardPtySpawnFlags', () => {
  it('enables wrap for terminal tabs', () => {
    expect(yuheardPtySpawnFlags({
      tabKind: 'terminal',
      agentId: null,
      autoWrapEnabled: true,
    })).toMatchObject({ yuheard: true, autoWrap: true })
    expect(yuheardPtySpawnFlags({
      tabKind: 'terminal',
      agentId: null,
      autoWrapEnabled: true,
    }).wrapAgentIds).toContain('codex')
  })

  it('keeps chat sidecars off YuHeard', () => {
    expect(yuheardPtySpawnFlags({
      tabKind: 'chat',
      autoWrapEnabled: true,
    })).toEqual({
      yuheard: false,
      autoWrap: false,
      wrapAgentIds: [],
      agentId: null,
    })
  })

  it('does not wrap ssh panes', () => {
    expect(yuheardPtySpawnFlags({
      tabKind: 'terminal',
      shell: 'ssh',
      autoWrapEnabled: true,
    }).autoWrap).toBe(false)
  })
})
