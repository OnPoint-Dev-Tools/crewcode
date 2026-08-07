import electron from 'electron'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { posix } from 'path'
import { isRemoteRoot } from './remote/ssh-target'
import {
  remoteListFiles,
  remotePathExists,
  remoteReadBuffer,
  remoteWriteBuffer,
  remoteWriteBufferExclusive,
} from './remote/remote-fs'
import {
  exportWriterDocument,
  importWriterDocument,
  MAX_WRITER_DOCUMENT_BYTES,
  MAX_WRITER_MARKDOWN_BYTES,
} from './writer-document-conversion'
import {
  documentDigest,
  findWriterDocumentLink,
  generatedExportMatches,
  loadWriterDocumentLinks,
  putWriterDocumentLink,
  saveWriterDocumentLinks,
  type WriterDocumentLink,
} from './writer-document-links'
import type { WriterBinaryFormat, WriterDocumentExportResult, WriterDocumentImportResult } from '../shared/writer-document-types'
import { uniqueWriterDerivativeRel } from './writer-document-paths'

const { app, ipcMain } = electron

function safeUnder(root: string, target: string): boolean {
  const a = normalize(root)
  const b = normalize(target)
  return b === a || b.startsWith(a + sep)
}

function normalizedRel(rel: string): string {
  return rel.replace(/\\/g, '/')
}

function formatForRel(rel: string): WriterBinaryFormat | null {
  const extension = posix.extname(normalizedRel(rel)).toLowerCase()
  return extension === '.docx' ? 'docx' : extension === '.pdf' ? 'pdf' : null
}

async function pathExists(root: string, rel: string): Promise<boolean> {
  if (isRemoteRoot(root)) return remotePathExists(root, rel)
  if (!root || !isAbsolute(root)) return false
  const target = join(root, rel)
  return safeUnder(root, target) && existsSync(target)
}

async function existingFiles(root: string): Promise<Set<string>> {
  if (isRemoteRoot(root)) {
    const result = await remoteListFiles(root)
    if (result.error) throw new Error(result.error)
    return new Set(result.files ?? [])
  }
  if (!root || !isAbsolute(root)) throw new Error('absolute root required')
  const files = new Set<string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'out') continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.add(join(directory === root ? '' : relative(root, directory), entry.name).replace(/\\/g, '/'))
      if (files.size > 20_000) return
    }
  }
  if (existsSync(root)) walk(root)
  return files
}

async function derivativeRel(
  root: string,
  sourceRel: string,
  extension: 'md' | WriterBinaryFormat,
): Promise<string> {
  const existing = await existingFiles(root)
  let rel = uniqueWriterDerivativeRel(sourceRel, extension, existing)
  if (!isRemoteRoot(root)) return rel

  // Git-based remote listings omit ignored files; verify each candidate over
  // SFTP so an ignored manuscript/export is still never replaced.
  while (await remotePathExists(root, rel)) {
    existing.add(rel)
    rel = uniqueWriterDerivativeRel(sourceRel, extension, existing)
  }
  return rel
}

async function readBuffer(root: string, rel: string, maxBytes: number): Promise<Buffer> {
  if (isRemoteRoot(root)) {
    const result = await remoteReadBuffer(root, rel, maxBytes)
    if (!result.ok || !result.data) throw new Error(result.error ?? 'failed to read document')
    return result.data
  }
  if (!root || !isAbsolute(root)) throw new Error('absolute root required')
  const target = join(root, rel)
  if (!safeUnder(root, target)) throw new Error('path escapes root')
  if (!existsSync(target)) throw new Error('file missing')
  const stat = statSync(target)
  if (!stat.isFile()) throw new Error('is not a file')
  if (stat.size > maxBytes) throw new Error(`document exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB limit`)
  return readFileSync(target)
}

async function readWorkingText(root: string, rel: string): Promise<string> {
  return (await readBuffer(root, rel, MAX_WRITER_MARKDOWN_BYTES)).toString('utf8')
}

async function writeExclusive(root: string, rel: string, data: Buffer): Promise<void> {
  if (isRemoteRoot(root)) {
    const result = await remoteWriteBufferExclusive(root, rel, data)
    if (!result.ok) throw new Error(result.error ?? 'failed to create generated document')
    return
  }
  const target = join(root, rel)
  if (!safeUnder(root, target)) throw new Error('path escapes root')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, data, { flag: 'wx' })
}

async function replaceOwned(root: string, rel: string, data: Buffer): Promise<void> {
  if (isRemoteRoot(root)) {
    const result = await remoteWriteBuffer(root, rel, data)
    if (!result.ok) throw new Error(result.error ?? 'failed to update generated document')
    return
  }
  const target = join(root, rel)
  if (!safeUnder(root, target)) throw new Error('path escapes root')
  writeFileSync(target, data)
}

async function handleImport(root: string, requestedRel: string): Promise<WriterDocumentImportResult> {
  try {
    const sourceRel = normalizedRel(requestedRel)
    if (!formatForRel(sourceRel)) return { error: 'Writer can import only .docx and .pdf files' }

    const userData = app.getPath('userData')
    const store = loadWriterDocumentLinks(userData, root)
    const existingLink = findWriterDocumentLink(store, sourceRel)
    if (existingLink && await pathExists(root, existingLink.workingRel)) {
      const markdown = await readWorkingText(root, existingLink.workingRel)
      return {
        ok: true,
        rel: existingLink.workingRel,
        markdown,
        sourceRel: existingLink.sourceRel ?? sourceRel,
        reused: true,
        warnings: ['Reopened the existing linked Markdown working copy.'],
      }
    }

    // If a generated derivative was clicked and its working copy disappeared,
    // prefer the preserved original source when it still exists.
    const conversionRel = existingLink?.sourceRel && await pathExists(root, existingLink.sourceRel)
      ? existingLink.sourceRel
      : sourceRel
    const format = formatForRel(conversionRel)
    if (!format) return { error: 'linked source format is unsupported' }
    const imported = await importWriterDocument(
      await readBuffer(root, conversionRel, MAX_WRITER_DOCUMENT_BYTES),
      format,
    )
    const workingRel = await derivativeRel(root, conversionRel, 'md')
    await writeExclusive(root, workingRel, Buffer.from(imported.markdown, 'utf8'))

    const link: WriterDocumentLink = {
      sourceRel: existingLink?.sourceRel ?? conversionRel,
      workingRel,
      exports: existingLink?.exports ?? {},
    }
    putWriterDocumentLink(store, link)
    saveWriterDocumentLinks(userData, root, store)
    return {
      ok: true,
      rel: workingRel,
      markdown: imported.markdown,
      sourceRel: link.sourceRel,
      warnings: imported.warnings,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function handleExport(
  root: string,
  requestedWorkingRel: string,
  markdown: string,
  format: WriterBinaryFormat,
): Promise<WriterDocumentExportResult> {
  try {
    if (format !== 'docx' && format !== 'pdf') return { error: 'unsupported export format' }
    if (typeof markdown !== 'string') return { error: 'document text required' }
    if (Buffer.byteLength(markdown, 'utf8') > MAX_WRITER_MARKDOWN_BYTES) return { error: 'document text exceeds 2MB limit' }

    const workingRel = normalizedRel(requestedWorkingRel)
    const userData = app.getPath('userData')
    const store = loadWriterDocumentLinks(userData, root)
    const link = findWriterDocumentLink(store, workingRel) ?? { workingRel, exports: {} }
    const data = await exportWriterDocument(markdown, format)
    const previous = link.exports[format]
    let outputRel = previous?.rel
    let replace = false

    if (previous && await pathExists(root, previous.rel)) {
      const current = await readBuffer(root, previous.rel, MAX_WRITER_DOCUMENT_BYTES)
      if (generatedExportMatches(previous, current)) replace = true
      else outputRel = undefined
    }

    if (!outputRel) outputRel = await derivativeRel(root, link.sourceRel ?? workingRel, format)
    if (replace) await replaceOwned(root, outputRel, data)
    else await writeExclusive(root, outputRel, data)

    link.exports[format] = { rel: outputRel, sha256: documentDigest(data) }
    putWriterDocumentLink(store, link)
    saveWriterDocumentLinks(userData, root, store)
    return { ok: true, rel: outputRel }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerWriterDocumentIpc(): void {
  ipcMain.handle('writerDocuments:import', (_event, root: string, sourceRel: string) => handleImport(root, sourceRel))
  ipcMain.handle(
    'writerDocuments:export',
    (_event, root: string, sourceRel: string, markdown: string, format: WriterBinaryFormat) =>
      handleExport(root, sourceRel, markdown, format),
  )
}
