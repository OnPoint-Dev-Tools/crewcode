export interface ContextMenuPoint { x: number; y: number }
export interface ContextMenuSize { width: number; height: number }

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max))

/** Keep a cursor-anchored menu fully visible, flipping before clamping at an edge. */
export function fitContextMenuPosition(
  anchor: ContextMenuPoint,
  menu: ContextMenuSize,
  viewport: ContextMenuSize,
  margin = 8,
): ContextMenuPoint {
  const preferredX = anchor.x + menu.width + margin <= viewport.width ? anchor.x : anchor.x - menu.width
  const preferredY = anchor.y + menu.height + margin <= viewport.height ? anchor.y : anchor.y - menu.height
  return {
    x: clamp(preferredX, margin, viewport.width - menu.width - margin),
    y: clamp(preferredY, margin, viewport.height - menu.height - margin),
  }
}
