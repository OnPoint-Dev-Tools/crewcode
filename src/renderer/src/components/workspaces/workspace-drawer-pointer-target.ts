interface SelectorMatchTarget {
  matches: (selector: string) => boolean
}

/** True when a pointer event originated anywhere inside the workspace dock. */
export function pointerEventCameFromWorkspaceDock(event: Pick<Event, 'composedPath'>): boolean {
  return event.composedPath().some(target => {
    const candidate = target as Partial<SelectorMatchTarget>
    return typeof candidate.matches === 'function' && candidate.matches('.ws-dock')
  })
}
