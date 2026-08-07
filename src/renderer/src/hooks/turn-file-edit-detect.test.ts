import { describe, expect, it } from 'vitest'

import { buildUnifiedDiff, collectTouchedPaths, diffStats, extractFilePathFromToolArgs, extractFilePathsFromToolArgs, extractProviderPatchChanges, isFileEditTool, normalizePatchForPierre, parsePreviewDiff, resultHasPatchSignal } from './turn-file-edit-detect'

describe('extractFilePathFromToolArgs', () => {
  it('recognizes lowercase file-editing tool names', () => {
    expect(extractFilePathFromToolArgs('write', { path: 'src/foo.ts' })).toBe('src/foo.ts')
    expect(extractFilePathFromToolArgs('edit', { file_path: 'src/bar.ts' })).toBe('src/bar.ts')
    expect(extractFilePathFromToolArgs('apply_patch', { path: 'src/baz.ts' })).toBe('src/baz.ts')
  })

  it('normalizes mixed-case legacy tool names', () => {
    expect(extractFilePathFromToolArgs('Edit', { path: 'src/foo.ts' })).toBe('src/foo.ts')
    expect(extractFilePathFromToolArgs('Write', { path: 'src/foo.ts' })).toBe('src/foo.ts')
    expect(extractFilePathFromToolArgs('MultiEdit', { path: 'src/foo.ts' })).toBe('src/foo.ts')
  })

  it('extracts paths from a multi-file patch changes array', () => {
    const args = {
      changes: [
        { path: 'src/a.ts', diff: '...' },
        { path: 'src/b.ts', diff: '...' },
      ],
    }
    expect(extractFilePathFromToolArgs('apply_patch', args)).toBe('src/a.ts')
    expect(extractFilePathsFromToolArgs('apply_patch', args)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('falls back to common path field names', () => {
    expect(extractFilePathFromToolArgs('write', { filename: 'f.ts' })).toBe('f.ts')
    expect(extractFilePathFromToolArgs('write', { target_file: 'g.ts' })).toBe('g.ts')
    expect(extractFilePathFromToolArgs('edit', { filePath: 'h.ts' })).toBe('h.ts')
    expect(extractFilePathFromToolArgs('edit', { FilePath: 'i.ts' })).toBe('i.ts')
    expect(extractFilePathFromToolArgs('edit', { file: 'file.ts' })).toBe('file.ts')
    expect(extractFilePathFromToolArgs('edit', { file_name: 'name.ts' })).toBe('name.ts')
    expect(extractFilePathFromToolArgs('edit', { targetFile: 'j.ts' })).toBe('j.ts')
  })

  it('falls back to args shape for unknown file-mutation tool names', () => {
    // pi-style tool with a capitalized FilePath and old/new strings.
    expect(extractFilePathFromToolArgs('modifies', {
      FilePath: 'src/foo.ts',
      oldString: 'old',
      newString: 'new',
    })).toBe('src/foo.ts')
    // Unknown write-like tool.
    expect(extractFilePathFromToolArgs('write_file', { path: 'src/bar.ts', content: 'x' })).toBe('src/bar.ts')
  })

  it('ignores non-file-editing tools', () => {
    expect(extractFilePathFromToolArgs('bash', { path: 'src/foo.ts' })).toBeNull()
    expect(extractFilePathFromToolArgs('read', { path: 'src/foo.ts' })).toBeNull()
    // A read-only tool with a path but no mutation payload must stay ignored.
    expect(extractFilePathFromToolArgs('list', { path: 'src/foo.ts' })).toBeNull()
  })
})

describe('extractProviderPatchChanges', () => {
  it('normalizes provider patch payloads for Pierre', () => {
    const changes = extractProviderPatchChanges({
      changes: [{ path: 'src/a.ts', kind: { type: 'modify' }, diff: '--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' }],
    })
    expect(changes).toHaveLength(1)
    expect(changes[0].patch).toMatch(/^diff --git a\/src\/a.ts b\/src\/a.ts/)
    expect(changes[0].patch).toMatch(/^--- a\/src\/a.ts/m)
    expect(changes[0].patch).toMatch(/^\+\+\+ b\/src\/a.ts/m)
  })

  it('finds a real unified diff nested under result.details.diff', () => {
    const result = {
      content: [{ type: 'text', text: 'Successfully replaced 3 block(s) in src/a.ts.' }],
      path: 'src/a.ts',
      details: { diff: '--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new\n', firstChangedLine: 75 },
    }
    const changes = extractProviderPatchChanges(undefined, result)
    expect(changes).toHaveLength(1)
    expect(changes[0].path).toBe('src/a.ts')
    expect(changes[0].patch).toMatch(/^diff --git a\/src\/a.ts b\/src\/a.ts/)
  })

  it('builds add/delete patches from a changes array (full-content diffs)', () => {
    const added = extractProviderPatchChanges({
      changes: [{ path: 'src/new.ts', kind: { type: 'add' }, diff: 'line one\nline two\n' }],
    })
    expect(added).toHaveLength(1)
    expect(added[0].patch).toMatch(/^new file mode 100644/m)
    expect(added[0].patch).toMatch(/^\+line one$/m)

    const removed = extractProviderPatchChanges({
      changes: [{ path: 'src/old.ts', kind: { type: 'delete' }, diff: 'gone\n' }],
    })
    expect(removed[0].patch).toMatch(/^deleted file mode 100644/m)
    expect(removed[0].patch).toMatch(/^-gone$/m)
  })

  it('rejects table/preview text with no +/- markers Pierre cannot parse', () => {
    // A markdown table preview has line numbers but no add/remove markers, so
    // there is no real diff to render — drop it (git fallback may produce one).
    const result = {
      path: 'src/a.ts',
      details: { diff: '  71 | --- | --- |\n  72 | Custom tools | Active\n', firstChangedLine: 71 },
    }
    expect(extractProviderPatchChanges(undefined, result)).toHaveLength(0)
  })

  it("converts pi's line-numbered preview diff (path in args, diff in result.details) to unified", () => {
    // Real shape from the pi/crewcoder edit tool: the path lives ONLY in args
    // (`{ path, edits }`), while the line-numbered preview lives in
    // result.details.diff — the two are in separate payloads.
    const args = { path: 'src/cli.ts', edits: [{ oldText: 'a', newText: 'b' }] }
    const result = {
      content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in src/cli.ts.' }],
      details: {
        firstChangedLine: 42,
        diff: [
          '     ...',
          '  41 import { foo } from "./foo.js";',
          '+ 42 import { bar } from "./bar.js";',
          '  42 ',
          '  43 const program = new Command();',
          '     ...',
          ' 194   handleErrors();',
          '+199 program.command("renderers");',
        ].join('\n'),
      },
    }
    const changes = extractProviderPatchChanges(undefined, args, result)
    expect(changes).toHaveLength(1)
    expect(changes[0].path).toBe('src/cli.ts')
    const patch = changes[0].patch
    expect(patch).toMatch(/^diff --git a\/src\/cli.ts b\/src\/cli.ts/)
    expect(patch).toMatch(/^@@ -41,3 \+41,4 @@/m)
    expect(patch).toMatch(/^\+import \{ bar \} from "\.\/bar\.js";$/m)
    expect(patch).toMatch(/^@@ -194,1 \+194,2 @@/m)
    expect(diffStats(patch)).toEqual({ added: 2, removed: 0 })
  })

  it('strips non-git patch headers before Pierre rendering', () => {
    const patch = normalizePatchForPierre('src/a.ts', 'Index: src/a.ts\n===================================================================\n--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new\n')
    expect(patch).toMatch(/^diff --git a\/src\/a.ts b\/src\/a.ts/)
    expect(patch).not.toMatch(/^Index:/m)
    expect(patch).not.toMatch(/^===/m)
    expect(patch).toMatch(/^@@ /m)
  })
})

describe('resultHasPatchSignal', () => {
  it('detects a diff signal even in unparseable preview format', () => {
    const result = { details: { diff: '  72 | text', firstChangedLine: 72 } }
    expect(resultHasPatchSignal(result)).toBe(true)
  })

  it('detects a top-level patch or changes array', () => {
    expect(resultHasPatchSignal({ patch: 'whatever' })).toBe(true)
    expect(resultHasPatchSignal({ changes: [] })).toBe(true)
  })

  it('returns false for a plain success message with no diff', () => {
    expect(resultHasPatchSignal({ content: [{ type: 'text', text: 'done' }] })).toBe(false)
  })
})

describe('collectTouchedPaths', () => {
  it('gathers paths from args and nested result details', () => {
    const args = { path: 'src/a.ts' }
    const result = { details: { path: 'src/b.ts' }, changes: [{ path: 'src/c.ts' }] }
    expect(collectTouchedPaths(args, result)).toEqual(['src/a.ts', 'src/c.ts', 'src/b.ts'])
  })

  it('dedupes the same path seen in args and result', () => {
    expect(collectTouchedPaths({ path: 'src/a.ts' }, { path: 'src/a.ts' })).toEqual(['src/a.ts'])
  })
})

describe('isFileEditTool', () => {
  it('gates reads and bash out of the git fallback', () => {
    expect(isFileEditTool('read', { path: 'a.ts' })).toBe(false)
    expect(isFileEditTool('bash', { command: 'ls' })).toBe(false)
  })

  it('recognizes known and heuristic edit tools', () => {
    expect(isFileEditTool('edit', { path: 'a.ts' })).toBe(true)
    expect(isFileEditTool('custom_writer', { path: 'a.ts', content: 'x' })).toBe(true)
  })

  it('tolerates missing or non-object args', () => {
    expect(isFileEditTool('write', undefined)).toBe(true)
    expect(isFileEditTool('mystery', undefined)).toBe(false)
  })
})

describe('parsePreviewDiff', () => {
  it('returns null for already-unified diffs and for text without markers', () => {
    expect(parsePreviewDiff('f', 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n')).toBeNull()
    expect(parsePreviewDiff('f', '  10 just context\n  11 more context')).toBeNull()
  })

  it('handles removals and produces consistent hunk counts', () => {
    const raw = ['  10 keep', '- 11 gone', '+ 11 added', '  12 keep'].join('\n')
    const patch = parsePreviewDiff('f.ts', raw)!
    expect(patch).toMatch(/^@@ -10,3 \+10,3 @@/m)
    expect(patch).toMatch(/^-gone$/m)
    expect(patch).toMatch(/^\+added$/m)
    expect(diffStats(patch)).toEqual({ added: 1, removed: 1 })
  })
})

describe('diffStats', () => {
  it('counts added and removed lines, ignoring +++/--- headers', () => {
    const patch = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n+extra\n'
    expect(diffStats(patch)).toEqual({ added: 2, removed: 1 })
  })

  it('returns zeros for an empty or undefined patch', () => {
    expect(diffStats(undefined)).toEqual({ added: 0, removed: 0 })
    expect(diffStats('')).toEqual({ added: 0, removed: 0 })
  })
})

describe('buildUnifiedDiff', () => {
  it('returns an empty string when before and after are identical', () => {
    expect(buildUnifiedDiff('src/foo.ts', 'same', 'same')).toBe('')
  })

  it('produces a git-style patch PierreDiff can parse', () => {
    const patch = buildUnifiedDiff('src/foo.ts', 'old\n', 'new\n')
    expect(patch).toMatch(/^diff --git a\/src\/foo.ts b\/src\/foo.ts/)
    expect(patch).toMatch(/^--- a\/src\/foo.ts/m)
    expect(patch).toMatch(/^\+\+\+ b\/src\/foo.ts/m)
    expect(patch).toMatch(/^@@ /m)
    expect(patch).not.toMatch(/^Index:/m)
  })

  it('marks new files with /dev/null and new file mode', () => {
    const patch = buildUnifiedDiff('src/foo.ts', '', 'new\n')
    expect(patch).toMatch(/^new file mode 100644/m)
    expect(patch).toMatch(/^--- \/dev\/null/m)
    expect(patch).toMatch(/^\+\+\+ b\/src\/foo.ts/m)
  })

  it('marks deleted files with /dev/null and deleted file mode', () => {
    const patch = buildUnifiedDiff('src/foo.ts', 'old\n', '')
    expect(patch).toMatch(/^deleted file mode 100644/m)
    expect(patch).toMatch(/^--- a\/src\/foo.ts/m)
    expect(patch).toMatch(/^\+\+\+ \/dev\/null/m)
  })
})
