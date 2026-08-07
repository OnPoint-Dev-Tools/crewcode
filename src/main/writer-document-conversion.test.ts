import { describe, expect, it } from 'vitest'
import { exportWriterDocument, importWriterDocument, markdownBlocks } from './writer-document-conversion'
import { uniqueWriterRel } from './writer-document-paths'

describe('Writer document paths', () => {
  it('uses collision-safe sibling names without replacing originals', () => {
    const existing = new Set([
      'drafts/chapter.md',
      'drafts/chapter.writer.md',
      'drafts/chapter.writer-2.md',
      'drafts/chapter.docx',
    ])

    expect(uniqueWriterRel('drafts/chapter.docx', 'md', existing)).toBe('drafts/chapter.writer-3.md')
    expect(uniqueWriterRel('drafts/chapter.md', 'docx', existing)).toBe('drafts/chapter.writer.docx')
    expect(uniqueWriterRel('drafts\\new.pdf', 'md', existing)).toBe('drafts/new.md')
  })
})

describe('Writer document conversion', () => {
  const markdown = `# Chapter title

A short **opening** paragraph with file_name and glob* literals.

- First point
- Second point

1. Ordered first
2. Ordered second

> A quoted line

\`\`\`
const answer = 42
\`\`\``

  it('maps supported Markdown structures into export blocks', () => {
    expect(markdownBlocks(markdown).map(block => block.kind)).toEqual([
      'heading', 'paragraph', 'bullet', 'bullet', 'number', 'number', 'quote', 'code',
    ])
  })

  it('exports a valid DOCX and imports its editable text', async () => {
    const docx = await exportWriterDocument(markdown, 'docx')
    expect(docx.subarray(0, 2).toString()).toBe('PK')

    const imported = await importWriterDocument(docx, 'docx')
    expect(imported.markdown).toContain('# Chapter title')
    expect(imported.markdown).toContain('First point')
    expect(imported.markdown).toMatch(/file\\?_name and glob\\?\* literals/)
    expect(imported.markdown).toContain('Ordered first')
    expect(imported.markdown).toContain('const answer = 42')
  })

  it('rejects multibyte Markdown that exceeds the normal workspace read limit', async () => {
    await expect(exportWriterDocument('é'.repeat(1_048_577), 'pdf')).rejects.toThrow('exceeds 2MB limit')
  })

  it('exports a valid PDF and extracts its selectable text', async () => {
    const pdf = await exportWriterDocument(markdown, 'pdf')
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')

    const imported = await importWriterDocument(pdf, 'pdf')
    expect(imported.markdown).toContain('Chapter title')
    expect(imported.markdown).toContain('First point')
    expect(imported.markdown).toContain('file_name and glob* literals')
    expect(imported.markdown).toMatch(/1\.\s+Ordered first/)
  })
})
