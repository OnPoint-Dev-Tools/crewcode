import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  documentDigest,
  findWriterDocumentLink,
  generatedExportMatches,
  loadWriterDocumentLinks,
  putWriterDocumentLink,
  saveWriterDocumentLinks,
  type WriterDocumentLinkStore,
} from './writer-document-links'
import { uniqueWriterDerivativeRel } from './writer-document-paths'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Writer document links', () => {
  it('persists one link addressable by source, working copy, and generated export', () => {
    const userData = mkdtempSync(join(tmpdir(), 'crewcode-writer-links-'))
    temporaryDirectories.push(userData)
    const root = '/workspace/book'
    const generated = Buffer.from('generated docx bytes')
    const store = loadWriterDocumentLinks(userData, root)
    const link = {
      sourceRel: 'chapter.docx',
      workingRel: 'chapter.writer.md',
      exports: {
        docx: { rel: 'chapter.writer.docx', sha256: documentDigest(generated) },
      },
    }

    putWriterDocumentLink(store, link)
    saveWriterDocumentLinks(userData, root, store)
    const restored = loadWriterDocumentLinks(userData, root)

    expect(findWriterDocumentLink(restored, 'chapter.docx')).toEqual(link)
    expect(findWriterDocumentLink(restored, 'chapter.writer.md')).toEqual(link)
    expect(findWriterDocumentLink(restored, 'chapter.writer.docx')).toEqual(link)
  })

  it('updates an existing working-copy link instead of appending duplicates', () => {
    const store: WriterDocumentLinkStore = { version: 1, links: [] }
    putWriterDocumentLink(store, { sourceRel: 'chapter.docx', workingRel: 'chapter.writer.md', exports: {} })
    putWriterDocumentLink(store, {
      sourceRel: 'chapter.docx',
      workingRel: 'chapter.writer.md',
      exports: { pdf: { rel: 'chapter.writer.pdf', sha256: documentDigest(Buffer.from('pdf')) } },
    })

    expect(store.links).toHaveLength(1)
    expect(store.links[0].exports.pdf?.rel).toBe('chapter.writer.pdf')
  })

  it('replaces a generated derivative only while its content hash still matches', () => {
    const original = Buffer.from('owned output')
    const output = { rel: 'chapter.writer.docx', sha256: documentDigest(original) }

    expect(generatedExportMatches(output, original)).toBe(true)
    expect(generatedExportMatches(output, Buffer.from('externally modified'))).toBe(false)
  })

  it('uses one clear writer derivative and advances only on real collisions', () => {
    expect(uniqueWriterDerivativeRel('drafts/chapter.docx', 'md', new Set()))
      .toBe('drafts/chapter.writer.md')
    expect(uniqueWriterDerivativeRel(
      'drafts/chapter.docx',
      'md',
      new Set(['drafts/chapter.writer.md', 'drafts/chapter.writer-2.md']),
    )).toBe('drafts/chapter.writer-3.md')
  })
})
