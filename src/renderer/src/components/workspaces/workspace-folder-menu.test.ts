import { describe, expect, it } from 'vitest'
import { hasWorkspaceFolderDestination } from './workspace-folder-menu'

describe('workspace folder context menu', () => {
  it('has no move destination before a folder exists', () => {
    expect(hasWorkspaceFolderDestination([], null)).toBe(false)
  })

  it('lets an unfiled project move once a folder exists', () => {
    expect(hasWorkspaceFolderDestination(['Client A'], null)).toBe(true)
  })

  it('does not treat the current folder as a move destination', () => {
    expect(hasWorkspaceFolderDestination(['Client A'], 'Client A')).toBe(false)
    expect(hasWorkspaceFolderDestination(['Client A', 'Client B'], 'Client A')).toBe(true)
  })
})
