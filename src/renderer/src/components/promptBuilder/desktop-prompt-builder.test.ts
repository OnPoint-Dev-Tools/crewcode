import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(__dirname, '../../styles/prompt-builder.css'), 'utf8')

describe('Prompt Builder desktop list scrolling', () => {
  it('bounds the inner rail so the prompt and skill cards own desktop scrolling', () => {
    expect(styles).toMatch(/@media \(min-width: 769px\) \{[\s\S]*?\.pb-inner \{[\s\S]*?flex: 1 1 auto;[\s\S]*?display: flex;[\s\S]*?flex-direction: column;[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/)
    expect(styles).toMatch(/@media \(min-width: 769px\) \{[\s\S]*?\.pb-list \{ min-height: 0; \}/)
  })

  it('keeps the phone contract in its separate max-width breakpoint', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\) \{[\s\S]*?\.pb-inner \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;/)
    expect(styles).toMatch(/@media \(max-width: 768px\) \{[\s\S]*?\.pb-list \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;/)
  })
})
