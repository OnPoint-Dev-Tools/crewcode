export type SurfaceOpenState = Record<string, boolean>

export function isSurfaceOpen(state: SurfaceOpenState, surfaceId: string): boolean {
  return state[surfaceId] ?? false
}

export function setSurfaceOpen(
  state: SurfaceOpenState,
  surfaceId: string,
  open: boolean,
): SurfaceOpenState {
  if ((state[surfaceId] ?? false) === open) return state
  return { ...state, [surfaceId]: open }
}
