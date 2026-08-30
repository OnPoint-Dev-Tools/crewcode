import { basename, extname } from 'path'

/** Collision-safe copy name: `foo.ts` → `foo copy.ts` → `foo copy 2.ts`. */
export function uniqueCopyName(fileName: string, taken: (candidate: string) => boolean): string {
  if (!taken(fileName)) return fileName
  const ext = extname(fileName)
  const stem = basename(fileName, ext)
  let n = 1
  while (n < 10_000) {
    const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`
    if (!taken(candidate)) return candidate
    n++
  }
  throw new Error('too many copies')
}
