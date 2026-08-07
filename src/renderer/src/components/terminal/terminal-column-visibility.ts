export function terminalColumnIsVisible(
  paneCount: number,
  controlledVisible: boolean | undefined,
  locallyHidden: boolean,
): boolean {
  if (paneCount === 0) return false
  return controlledVisible ?? !locallyHidden
}
