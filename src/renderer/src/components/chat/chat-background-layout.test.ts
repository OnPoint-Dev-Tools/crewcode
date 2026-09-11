import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')

describe('regular chat wallpaper layout', () => {
  it('gives the fresh-chat welcome content a mode-aware frosted surface', () => {
    expect(styles).toMatch(/\.has-chat-background \.fresh-chat-inner\s*\{[^}]*background: rgba\(7, 10, 8, 0\.52\);[^}]*backdrop-filter: blur\(20px\)/s)
    expect(styles).toMatch(/body\.light \.has-chat-background \.fresh-chat-inner\s*\{[^}]*background:/s)
    expect(styles).toMatch(/body\.dark \.has-chat-background \.fresh-chat-inner\s*\{[^}]*background:/s)
  })

  it('keeps the loader transparent and agent replies bubble-sized', () => {
    expect(styles).toMatch(/\.chat-col\.has-chat-background \.thread-sticky-loader\s*\{\s*background: transparent;/)
    expect(styles).toMatch(/\.chat-col\.has-chat-background \.agent-row\s*\{[^}]*width: fit-content;/s)
    expect(styles).toMatch(/\.chat-col\.has-chat-background \.agent-row\s*\{[^}]*max-width: 75%;/s)
    expect(styles).toMatch(/\.chat-col\.has-chat-background \.agent-row > \.agent\s*\{[^}]*flex: 0 1 auto;/s)
  })

  it('keeps the loader container clear while frosting the compact loading visual', () => {
    expect(styles).toMatch(/\.chat-col\.has-chat-background \.loading-block\s*\{[^}]*width: fit-content;[^}]*background:[^}]*backdrop-filter: blur\(16px\)/s)
    expect(styles).toMatch(/\.chat-col\.has-chat-background \.loading-block\.active \.loading-word\s*\{[^}]*animation: none;[^}]*text-shadow: none;/s)
    expect(styles).toMatch(/body\.light \.chat-col\.has-chat-background \.loading-block\s*\{[^}]*background:/s)
    expect(styles).toMatch(/body\.dark \.chat-col\.has-chat-background \.loading-block\s*\{[^}]*background:/s)
  })

  it('uses light and dark frosted surfaces for thinking and work logs', () => {
    expect(styles).toMatch(/\.chat-col\.has-chat-background \.thinking,\s*\.chat-col\.has-chat-background \.wl\.wl-compact\s*\{[^}]*width: fit-content;[^}]*max-width: 75%;[^}]*backdrop-filter: blur\(16px\)/s)
    expect(styles).toMatch(/body\.light \.chat-col\.has-chat-background \.thinking,\s*body\.light \.chat-col\.has-chat-background \.wl\.wl-compact\s*\{[^}]*background:/s)
    expect(styles).toMatch(/body\.dark \.chat-col\.has-chat-background \.thinking,\s*body\.dark \.chat-col\.has-chat-background \.wl\.wl-compact\s*\{[^}]*background:/s)
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.chat-col\.has-chat-background \.thinking,\s*\.chat-col\.has-chat-background \.wl\.wl-compact\s*\{\s*max-width: 92%;/)
  })
})
