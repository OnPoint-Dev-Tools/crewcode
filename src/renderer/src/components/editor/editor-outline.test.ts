import { describe, expect, it } from 'vitest'
import { extractTextOutline } from './editor-outline'

describe('editor outline fallback', () => {
  it('extracts TypeScript declarations and arrow functions', () => {
    const outline = extractTextOutline('example.tsx', `
export interface Props {}
export class Controller {}
export function run() {}
const Panel = () => null
`)
    expect(outline.map(item => [item.name, item.kind])).toEqual([
      ['Props', 'interface'],
      ['Controller', 'class'],
      ['run', 'function'],
      ['Panel', 'function'],
    ])
  })

  it('preserves Python and Markdown nesting depth', () => {
    expect(extractTextOutline('main.py', 'class App:\n    def start(self):\n        pass')).toMatchObject([
      { name: 'App', kind: 'class', depth: 0, line: 1 },
      { name: 'start', kind: 'function', depth: 1, line: 2 },
    ])
    expect(extractTextOutline('README.md', '# Intro\n## Install')).toMatchObject([
      { name: 'Intro', kind: 'heading', depth: 0 },
      { name: 'Install', kind: 'heading', depth: 1 },
    ])
  })

  it('returns an empty outline for unsupported plain text', () => {
    expect(extractTextOutline('notes.txt', 'plain text')).toEqual([])
  })
})
