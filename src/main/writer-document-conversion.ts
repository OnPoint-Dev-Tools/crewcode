import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import mammoth from 'mammoth'
import PDFDocument from 'pdfkit'
import TurndownService from 'turndown'
import { extractText } from 'unpdf'
import type { WriterBinaryFormat } from '../shared/writer-document-types'

export const MAX_WRITER_DOCUMENT_BYTES = 20 * 1024 * 1024
export const MAX_WRITER_MARKDOWN_BYTES = 2 * 1024 * 1024

export interface ImportedWriterDocument {
  markdown: string
  warnings: string[]
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

export async function importWriterDocument(buffer: Buffer, format: WriterBinaryFormat): Promise<ImportedWriterDocument> {
  if (buffer.byteLength > MAX_WRITER_DOCUMENT_BYTES) throw new Error('document exceeds 20MB limit')

  if (format === 'docx') {
    const converted = await mammoth.convertToHtml(
      { buffer },
      { externalFileAccess: false, includeDefaultStyleMap: true },
    )
    const turndown = new TurndownService({
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      headingStyle: 'atx',
      strongDelimiter: '**',
    })
    // Embedded images can become multi-megabyte data URLs that are not useful
    // in a text review; preserve the surrounding document instead.
    const htmlWithoutImages = converted.value.replace(/<img\b[^>]*>/gi, '')
    const markdown = normalizeMarkdown(turndown.turndown(htmlWithoutImages))
    if (Buffer.byteLength(markdown, 'utf8') > MAX_WRITER_MARKDOWN_BYTES) throw new Error('converted document text exceeds 2MB limit')
    return {
      markdown,
      warnings: converted.messages.map(message => message.message).filter(Boolean),
    }
  }

  const result = await extractText(new Uint8Array(buffer), { mergePages: false })
  const pages = result.text
    .map(page => normalizeMarkdown(page))
    .filter(Boolean)
  const markdown = pages.join('\n\n---\n\n')
  if (Buffer.byteLength(markdown, 'utf8') > MAX_WRITER_MARKDOWN_BYTES) throw new Error('converted document text exceeds 2MB limit')
  return {
    // Page boundaries remain visible but editable in the Markdown working copy.
    markdown,
    warnings: pages.length === 0 ? ['No selectable text was found. Scanned PDFs require OCR, which is not included.'] : [],
  }
}

interface MarkdownBlock {
  kind: 'heading' | 'paragraph' | 'bullet' | 'number' | 'quote' | 'code' | 'rule'
  text: string
  level?: number
}

export function markdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = normalizeMarkdown(markdown).split('\n')
  let paragraph: string[] = []
  let code: string[] | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }

  for (const line of lines) {
    if (/^```/.test(line)) {
      flushParagraph()
      if (code) {
        blocks.push({ kind: 'code', text: code.join('\n') })
        code = null
      } else {
        code = []
      }
      continue
    }
    if (code) { code.push(line); continue }
    if (!line.trim()) { flushParagraph(); continue }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line)
    const number = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    const quote = /^>\s?(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
    } else if (bullet) {
      flushParagraph()
      blocks.push({ kind: 'bullet', text: bullet[1] })
    } else if (number) {
      flushParagraph()
      blocks.push({ kind: 'number', text: number[1] })
    } else if (quote) {
      flushParagraph()
      blocks.push({ kind: 'quote', text: quote[1] })
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph()
      blocks.push({ kind: 'rule', text: '' })
    } else {
      paragraph.push(line.trim())
    }
  }
  if (code) blocks.push({ kind: 'code', text: code.join('\n') })
  flushParagraph()
  return blocks
}

function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?;:])/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?;:])/g, '$1$2')
}

function headingLevel(level = 1): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
  return levels[Math.max(0, Math.min(5, level - 1))]
}

async function exportDocx(markdown: string): Promise<Buffer> {
  const children = markdownBlocks(markdown).map(block => {
    const text = plainInline(block.text)
    if (block.kind === 'heading') return new Paragraph({ heading: headingLevel(block.level), text })
    if (block.kind === 'bullet') return new Paragraph({ bullet: { level: 0 }, text })
    if (block.kind === 'number') return new Paragraph({ numbering: { reference: 'writer-numbering', level: 0 }, text })
    if (block.kind === 'quote') return new Paragraph({ indent: { left: 720 }, children: [new TextRun({ text, italics: true })] })
    if (block.kind === 'code') return new Paragraph({ children: [new TextRun({ text: block.text, font: 'Courier New' })] })
    if (block.kind === 'rule') return new Paragraph({ text: '────────────────────────' })
    return new Paragraph({ text })
  })
  const document = new Document({
    numbering: {
      config: [{
        reference: 'writer-numbering',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'start' }],
      }],
    },
    sections: [{ children }],
  })
  return Packer.toBuffer(document)
}

function exportPdf(markdown: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ autoFirstPage: true, bufferPages: true, margin: 54, size: 'LETTER' })
    const chunks: Buffer[] = []
    pdf.on('data', chunk => chunks.push(Buffer.from(chunk)))
    pdf.on('error', reject)
    pdf.on('end', () => resolve(Buffer.concat(chunks)))

    let orderedIndex = 0
    for (const block of markdownBlocks(markdown)) {
      const text = plainInline(block.text)
      if (block.kind !== 'number') orderedIndex = 0
      if (block.kind === 'heading') {
        const sizes = [24, 20, 17, 15, 13, 12]
        pdf.font('Helvetica-Bold').fontSize(sizes[Math.max(0, Math.min(5, (block.level ?? 1) - 1))]).text(text)
        pdf.moveDown(0.45)
      } else if (block.kind === 'bullet') {
        pdf.font('Helvetica').fontSize(11).text(`•  ${text}`, { indent: 14 })
      } else if (block.kind === 'number') {
        orderedIndex++
        pdf.font('Helvetica').fontSize(11).text(`${orderedIndex}.  ${text}`, { indent: 14 })
      } else if (block.kind === 'quote') {
        pdf.font('Helvetica-Oblique').fontSize(11).fillColor('#444444').text(text, { indent: 18 })
        pdf.fillColor('#111111')
      } else if (block.kind === 'code') {
        pdf.font('Courier').fontSize(9).text(block.text, { indent: 12 })
      } else if (block.kind === 'rule') {
        const y = pdf.y + 4
        pdf.moveTo(54, y).lineTo(pdf.page.width - 54, y).strokeColor('#777777').stroke()
        pdf.moveDown()
      } else {
        pdf.font('Helvetica').fontSize(11).text(text, { lineGap: 2 })
      }
      pdf.moveDown(0.65)
    }
    pdf.end()
  })
}

export async function exportWriterDocument(markdown: string, format: WriterBinaryFormat): Promise<Buffer> {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_WRITER_MARKDOWN_BYTES) throw new Error('document text exceeds 2MB limit')
  return format === 'docx' ? exportDocx(markdown) : exportPdf(markdown)
}
