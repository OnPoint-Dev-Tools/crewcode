import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fitContextMenuPosition } from '../ui/context-menu-position'

const styles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')

describe('file-tree context menu positioning', () => {
  it('keeps a menu anchored at the pointer when it already fits', () => {
    expect(fitContextMenuPosition({ x: 100, y: 80 }, { width: 180, height: 240 }, { width: 1000, height: 800 }))
      .toEqual({ x: 100, y: 80 })
  })

  it('flips and clamps the menu inside the bottom-right viewport edge', () => {
    expect(fitContextMenuPosition({ x: 990, y: 790 }, { width: 180, height: 240 }, { width: 1000, height: 800 }))
      .toEqual({ x: 810, y: 550 })
  })

  it('pins an oversized menu to the viewport margin', () => {
    expect(fitContextMenuPosition({ x: 20, y: 20 }, { width: 500, height: 300 }, { width: 320, height: 240 }))
      .toEqual({ x: 8, y: 8 })
  })

  it('uses shared theme tokens instead of fixed green menu colors', () => {
    const menuStyles = styles.slice(styles.indexOf('.ft-ctx {'), styles.indexOf('/* ─── Git panel'))
    expect(menuStyles).toContain('background: var(--popover)')
    expect(menuStyles).toContain('color: var(--popover-foreground)')
    expect(menuStyles).toContain('background: var(--accent)')
    expect(menuStyles).toContain('color: var(--destructive)')
    expect(menuStyles).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})
