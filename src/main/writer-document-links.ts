import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { WriterBinaryFormat } from '../shared/writer-document-types'

export interface WriterGeneratedExport {
  rel: string
  sha256: string
}

export interface WriterDocumentLink {
  sourceRel?: string
  workingRel: string
  exports: Partial<Record<WriterBinaryFormat, WriterGeneratedExport>>
}

export interface WriterDocumentLinkStore {
  version: 1
  links: WriterDocumentLink[]
}

const EMPTY_STORE: WriterDocumentLinkStore = { version: 1, links: [] }

export function documentDigest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function generatedExportMatches(output: WriterGeneratedExport, data: Buffer): boolean {
  return documentDigest(data) === output.sha256
}

function safeRel(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false
  const normalized = value.replace(/\\/g, '/')
  return !normalized.startsWith('/') && !normalized.split('/').includes('..')
}

function validExport(value: unknown): value is WriterGeneratedExport {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WriterGeneratedExport>
  return safeRel(candidate.rel) && typeof candidate.sha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.sha256)
}

function validLink(value: unknown): value is WriterDocumentLink {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WriterDocumentLink>
  if (!safeRel(candidate.workingRel)) return false
  if (candidate.sourceRel !== undefined && !safeRel(candidate.sourceRel)) return false
  if (!candidate.exports || typeof candidate.exports !== 'object') return false
  return (!candidate.exports.docx || validExport(candidate.exports.docx))
    && (!candidate.exports.pdf || validExport(candidate.exports.pdf))
}

function storePath(userData: string, root: string): string {
  const rootDigest = createHash('sha256').update(root).digest('hex').slice(0, 24)
  return join(userData, 'writer-documents', `links.${rootDigest}.json`)
}

export function loadWriterDocumentLinks(userData: string, root: string): WriterDocumentLinkStore {
  const path = storePath(userData, root)
  if (!existsSync(path)) return { ...EMPTY_STORE, links: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WriterDocumentLinkStore>
    if (parsed.version !== 1 || !Array.isArray(parsed.links)) return { ...EMPTY_STORE, links: [] }
    return { version: 1, links: parsed.links.filter(validLink) }
  } catch {
    return { ...EMPTY_STORE, links: [] }
  }
}

export function saveWriterDocumentLinks(userData: string, root: string, store: WriterDocumentLinkStore): void {
  const path = storePath(userData, root)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  const serialized = JSON.stringify(store)
  writeFileSync(temporary, serialized, 'utf8')
  try {
    renameSync(temporary, path)
  } catch {
    // Windows does not consistently replace an existing destination on rename.
    writeFileSync(path, serialized, 'utf8')
    rmSync(temporary, { force: true })
  }
}

export function findWriterDocumentLink(store: WriterDocumentLinkStore, rel: string): WriterDocumentLink | undefined {
  const normalized = rel.replace(/\\/g, '/')
  return store.links.find(link => link.sourceRel === normalized
    || link.workingRel === normalized
    || Object.values(link.exports).some(output => output?.rel === normalized))
}

export function putWriterDocumentLink(store: WriterDocumentLinkStore, link: WriterDocumentLink): void {
  const index = store.links.findIndex(existing => existing.workingRel === link.workingRel
    || (link.sourceRel !== undefined && existing.sourceRel === link.sourceRel))
  if (index === -1) store.links.push(link)
  else store.links[index] = link
}
