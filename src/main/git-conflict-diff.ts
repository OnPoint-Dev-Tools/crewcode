import { createPatch } from 'diff'
import type { GitConflictDiffResult } from '../shared/git-conflict-types'

interface GitOutput { stdout: string; stderr: string }
export type GitConflictRunner = (args: string[]) => Promise<GitOutput>

const MAX_CONFLICT_SIDE_BYTES = 1024 * 1024

function errorMessage(error: unknown): string {
  const value = error as Error & { stderr?: string }
  return value.stderr?.trim() || value.message
}

function boundedText(value: string, side: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_CONFLICT_SIDE_BYTES) throw new Error(`${side} conflict content exceeds the 1 MiB review limit`)
  if (value.includes('\0')) throw new Error('Binary conflicts cannot be rendered as a text diff')
  return value
}

/** Reads Git's stage-2 (ours) and stage-3 (theirs) blobs for one observed conflict. */
export async function getGitConflictDiff(fileInput: string, run: GitConflictRunner): Promise<GitConflictDiffResult> {
  const file = fileInput.trim()
  if (!file || file.length > 4096 || file.includes('\0') || /[\r\n]/.test(file)) return { ok: false, patch: '', oursAvailable: false, theirsAvailable: false, error: 'Invalid conflict path' }
  try {
    await run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    const unresolved = await run(['diff', '--name-only', '--diff-filter=U', '--', file])
    if (!unresolved.stdout.split(/\r?\n/).includes(file)) return { ok: false, patch: '', oursAvailable: false, theirsAvailable: false, error: `${file} is no longer an unresolved merge conflict` }

    const readSide = async (stage: 2 | 3): Promise<string | null> => {
      let value: string
      try { value = (await run(['show', `:${stage}:${file}`])).stdout }
      catch { return null }
      return boundedText(value, stage === 2 ? 'Ours' : 'Theirs')
    }
    const [ours, theirs] = await Promise.all([readSide(2), readSide(3)])
    if (ours == null && theirs == null) return { ok: false, patch: '', oursAvailable: false, theirsAvailable: false, error: `Git did not return either side of ${file}` }

    const raw = createPatch(file, ours ?? '', theirs ?? '', 'ours (PR head)', 'theirs (base)', { context: 3 })
    const headers = raw.indexOf('--- ')
    const body = headers >= 0 ? raw.slice(headers) : raw
    const patch = `diff --git a/${file} b/${file}\n${body.replace(`--- ${file}`, `--- a/${file}`).replace(`+++ ${file}`, `+++ b/${file}`)}`
    return { ok: true, patch, oursAvailable: ours != null, theirsAvailable: theirs != null }
  } catch (error) {
    return { ok: false, patch: '', oursAvailable: false, theirsAvailable: false, error: errorMessage(error) }
  }
}
