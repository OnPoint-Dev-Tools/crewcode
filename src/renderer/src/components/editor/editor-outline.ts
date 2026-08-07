export type EditorOutlineKind = 'class' | 'interface' | 'function' | 'method' | 'variable' | 'type' | 'enum' | 'module' | 'heading' | 'selector' | 'tag'

export type EditorOutlineSymbol = {
  id: string
  name: string
  kind: EditorOutlineKind
  line: number
  column: number
  depth: number
}

function symbol(name: string, kind: EditorOutlineKind, line: number, column: number, depth = 0): EditorOutlineSymbol {
  return { id: `${line}:${column}:${kind}:${name}`, name, kind, line, column, depth }
}

/** Fast fallback for languages without an attached document-symbol provider. */
export function extractTextOutline(name: string, text: string): EditorOutlineSymbol[] {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const lines = text.split('\n')
  const result: EditorOutlineSymbol[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lineNumber = index + 1
    let match: RegExpExecArray | null = null
    let kind: EditorOutlineKind | null = null
    let label = ''
    let depth = 0

    if (['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
      match = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type|namespace|function)\s+([A-Za-z_$][\w$]*)/.exec(line)
      if (match) {
        const kinds: Record<string, EditorOutlineKind> = { class: 'class', interface: 'interface', enum: 'enum', type: 'type', namespace: 'module', function: 'function' }
        kind = kinds[match[1]]
        label = match[2]
      } else {
        match = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line)
        if (match) { kind = 'function'; label = match[1] }
      }
    } else if (ext === 'py') {
      match = /^(\s*)(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/.exec(line)
      if (match) {
        kind = match[2] === 'class' ? 'class' : 'function'
        label = match[3]
        depth = Math.floor(match[1].replace(/\t/g, '    ').length / 4)
      }
    } else if (ext === 'rs') {
      match = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod|type)\s+([^\s<{(;]+)/.exec(line)
      if (match) {
        const kinds: Record<string, EditorOutlineKind> = { fn: 'function', struct: 'class', enum: 'enum', trait: 'interface', impl: 'class', mod: 'module', type: 'type' }
        kind = kinds[match[1]]
        label = match[2]
      }
    } else if (['md', 'markdown', 'mdx'].includes(ext)) {
      match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (match) { kind = 'heading'; label = match[2]; depth = match[1].length - 1 }
    } else if (['css', 'scss', 'less'].includes(ext)) {
      match = /^\s*([^@/][^{]+)\s*\{\s*$/.exec(line)
      if (match) { kind = 'selector'; label = match[1].trim() }
    } else if (['html', 'xml', 'svg'].includes(ext)) {
      match = /^(\s*)<([A-Za-z][\w:-]*)(?:\s|>|\/)/.exec(line)
      if (match) { kind = 'tag'; label = match[2]; depth = Math.floor(match[1].replace(/\t/g, '  ').length / 2) }
    }

    if (kind && label && match) result.push(symbol(label.slice(0, 120), kind, lineNumber, Math.max(0, line.indexOf(label)), depth))
    if (result.length >= 500) break
  }
  return result
}
