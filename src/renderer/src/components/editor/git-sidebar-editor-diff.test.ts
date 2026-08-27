import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8')
const editor = readFileSync(fileURLToPath(new URL('./CodeEditor.tsx', import.meta.url)), 'utf8')
const sidebar = readFileSync(fileURLToPath(new URL('../git/GitSidebar.tsx', import.meta.url)), 'utf8')

describe('Git Sidebar editor diff route', () => {
  it('routes changed-file rows into the editor Pierre diff using the active worktree', () => {
    expect(sidebar).toContain('onClick={() => onOpenDiff?.(f.path, false)}')
    expect(app).toContain('api.gitDiffVsRef(effectivePath, comparisonRef, path)')
    expect(app).toContain('api.gitDiff(effectivePath, path, staged)')
    expect(app).toContain('setPendingGitDiff({ title, diff })')
    expect(editor).toContain('<PierreDiff patch={diff} className="ed-diff-body" />')
  })
})
