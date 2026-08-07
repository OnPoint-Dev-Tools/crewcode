import { describe, expect, it, vi } from 'vitest'

import { pointerEventCameFromWorkspaceDock } from './workspace-drawer-pointer-target'

function eventWithPath(path: EventTarget[]): Pick<Event, 'composedPath'> {
  return { composedPath: () => path }
}

function matchingElement(selector: string): EventTarget {
  return { matches: vi.fn((candidate: string) => candidate === selector) } as unknown as EventTarget
}

describe('workspace drawer pointer targets', () => {
  it('recognizes a direct workspace dock event', () => {
    expect(pointerEventCameFromWorkspaceDock(eventWithPath([
      matchingElement('.ws-dock'),
    ]))).toBe(true)
  })

  it('recognizes nested dock content through the composed path', () => {
    expect(pointerEventCameFromWorkspaceDock(eventWithPath([
      matchingElement('.ws-dock-chevron'),
      matchingElement('.ws-dock'),
    ]))).toBe(true)
  })

  it('allows genuine outside targets to close the drawer', () => {
    expect(pointerEventCameFromWorkspaceDock(eventWithPath([
      matchingElement('.app-body'),
      {} as EventTarget,
    ]))).toBe(false)
  })
})
