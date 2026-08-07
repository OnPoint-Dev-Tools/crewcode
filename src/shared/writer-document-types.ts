export type WriterBinaryFormat = 'docx' | 'pdf'

export interface WriterDocumentImportResult {
  ok?: boolean
  rel?: string
  markdown?: string
  sourceRel?: string
  reused?: boolean
  warnings?: string[]
  error?: string
}

export interface WriterDocumentExportResult {
  ok?: boolean
  rel?: string
  error?: string
}
