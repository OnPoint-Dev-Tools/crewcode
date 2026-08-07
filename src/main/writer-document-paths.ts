import { posix } from 'path'
import type { WriterBinaryFormat } from '../shared/writer-document-types'

/** Pick a sibling output path without ever replacing an existing document. */
export function uniqueWriterDerivativeRel(
  sourceRel: string,
  extension: 'md' | WriterBinaryFormat,
  existing: ReadonlySet<string>,
): string {
  const normalized = sourceRel.replace(/\\/g, '/')
  const source = posix.parse(normalized)
  let candidate = posix.join(source.dir, `${source.name}.writer.${extension}`)
  let suffix = 2
  while (existing.has(candidate)) {
    candidate = posix.join(source.dir, `${source.name}.writer-${suffix}.${extension}`)
    suffix++
  }
  return candidate
}

/** Legacy collision naming retained for existing callers and migrations. */
export function uniqueWriterRel(
  sourceRel: string,
  extension: 'md' | WriterBinaryFormat,
  existing: ReadonlySet<string>,
): string {
  const normalized = sourceRel.replace(/\\/g, '/')
  const source = posix.parse(normalized)
  const preferred = posix.join(source.dir, `${source.name}.${extension}`)
  if (!existing.has(preferred)) return preferred

  let candidate = posix.join(source.dir, `${source.name}.writer.${extension}`)
  let suffix = 2
  while (existing.has(candidate)) {
    candidate = posix.join(source.dir, `${source.name}.writer-${suffix}.${extension}`)
    suffix++
  }
  return candidate
}
