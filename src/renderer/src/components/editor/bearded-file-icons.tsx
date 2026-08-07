import React from 'react'
// icons.json and the SVGs it maps to are GPL-3.0 (Bearded Icons by BeardedBear), not
// Apache-2.0 like the rest of CrewCode. Used unmodified as data; see NOTICE before
// vendoring, editing, or relicensing anything in assets/bearded-icons/.
import iconTheme from '../../assets/bearded-icons/icons.json'

const iconModules = import.meta.glob('../../assets/bearded-icons/icons/*.svg', {
  eager: true,
  // Keep hundreds of SVGs out of the startup JS bundle; Vite emits hashed assets.
  query: '?url&no-inline',
  import: 'default',
}) as Record<string, string>

const iconUrlByFile = new Map(
  Object.entries(iconModules).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]),
)

const extensionLanguageIds: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'javascriptreact',
  json: 'json',
  jsonc: 'jsonc',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  markdown: 'markdown',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shellscript',
  bash: 'shellscript',
  sql: 'sql',
  svg: 'svg',
  ts: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  tsx: 'typescriptreact',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

type IconTheme = {
  iconDefinitions: Record<string, { iconPath: string }>
  file: string
  folder: string
  folderExpanded: string
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  languageIds: Record<string, string>
}

const theme = iconTheme as IconTheme

function iconUrl(iconId: string | undefined): string {
  const path = iconId ? theme.iconDefinitions[iconId]?.iconPath : undefined
  const file = path?.slice(path.lastIndexOf('/') + 1)
  return (file && iconUrlByFile.get(file)) || iconUrlByFile.get('file.svg') || ''
}

export function beardedFileIconUrl(name: string): string {
  const lower = name.toLowerCase()
  const named = theme.fileNames[lower]
  if (named) return iconUrl(named)

  const parts = lower.split('.')
  for (let index = 1; index < parts.length; index++) {
    const extension = parts.slice(index).join('.')
    const mapped = theme.fileExtensions[extension]
    if (mapped) return iconUrl(mapped)
  }

  const extension = parts.length > 1 ? parts[parts.length - 1] : ''
  const languageId = extensionLanguageIds[extension]
  return iconUrl((languageId && theme.languageIds[languageId]) || theme.file)
}

export function beardedFolderIconUrl(open: boolean): string {
  return iconUrl(open ? theme.folderExpanded : theme.folder)
}

export function BeardedFileIcon({
  name,
  directory = false,
  open = false,
  size = 14,
  className = '',
}: {
  name: string
  directory?: boolean
  open?: boolean
  size?: number
  className?: string
}) {
  const src = directory ? beardedFolderIconUrl(open) : beardedFileIconUrl(name)
  return <img className={`editor-file-icon ${className}`.trim()} src={src} width={size} height={size} alt="" draggable={false} />
}
