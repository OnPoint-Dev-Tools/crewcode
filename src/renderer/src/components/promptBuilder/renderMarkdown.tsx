/**
 * Tiny markdown → React renderer for the Prompt Builder preview pane.
 *
 * Returns React nodes (no innerHTML), so {{var}} tokens get rendered as
 * `.pb-var` spans without any sanitization concern. Prompts are small and
 * this scope is intentionally minimal — anything richer goes to the existing
 * MarkdownEditor.
 */
import React from 'react'

const VAR_RE = /(\{\{\s*[a-zA-Z0-9_-]+\s*\}\})/g
const VAR_INNER = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/

function renderInline(text: string): React.ReactNode[] {
  // First, split on the four inline patterns we care about. Process variables
  // last by splitting each chunk one more time so they nest inside code/bold.
  const out: React.ReactNode[] = []

  // Pattern split: backticks, **bold**, [text](url), {{var}}.
  // Tokenize greedily by walking the string.
  let buf = ''
  let i = 0
  const flush = (): void => {
    if (!buf) return
    // Split buf on {{var}} so the chip renders.
    const parts = buf.split(VAR_RE)
    parts.forEach((part, idx) => {
      const m = part.match(VAR_INNER)
      if (m) out.push(<span key={`v-${out.length}-${idx}`} className="pb-var">{`{{${m[1]}}}`}</span>)
      else if (part) out.push(part)
    })
    buf = ''
  }

  while (i < text.length) {
    const ch = text[i]
    // Inline code
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1) {
        flush()
        const inner = text.slice(i + 1, end)
        // Allow {{var}} inside code too.
        const parts = inner.split(VAR_RE)
        out.push(
          <code key={`c-${out.length}`}>
            {parts.map((part, idx) => {
              const m = part.match(VAR_INNER)
              return m
                ? <span key={idx} className="pb-var">{`{{${m[1]}}}`}</span>
                : <React.Fragment key={idx}>{part}</React.Fragment>
            })}
          </code>,
        )
        i = end + 1
        continue
      }
    }
    // Bold
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end !== -1) {
        flush()
        out.push(<strong key={`b-${out.length}`}>{renderInline(text.slice(i + 2, end))}</strong>)
        i = end + 2
        continue
      }
    }
    // Link
    if (ch === '[') {
      const close = text.indexOf(']', i + 1)
      if (close !== -1 && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2)
        if (paren !== -1) {
          flush()
          const label = text.slice(i + 1, close)
          const url   = text.slice(close + 2, paren)
          out.push(<a key={`a-${out.length}`} href={url}>{label}</a>)
          i = paren + 1
          continue
        }
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

interface Block {
  type: 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'code' | 'hr' | 'blockquote'
  lines: string[]
}

function parseBlocks(src: string): Block[] {
  const out: Block[] = []
  const lines = src.split('\n')
  let i = 0
  let listType: 'ul' | 'ol' | null = null
  let listLines: string[] = []
  const flushList = (): void => {
    if (listType && listLines.length) {
      out.push({ type: listType, lines: listLines })
    }
    listType = null
    listLines = []
  }

  while (i < lines.length) {
    const l = lines[i]
    let m: RegExpMatchArray | null

    if (l.startsWith('```')) {
      flushList()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]); i++
      }
      out.push({ type: 'code', lines: buf })
      i++ // skip closing fence
      continue
    }
    if ((m = l.match(/^(#{1,3})\s+(.*)$/))) {
      flushList()
      const lv = m[1].length
      out.push({ type: lv === 1 ? 'h1' : lv === 2 ? 'h2' : 'h3', lines: [m[2]] })
      i++; continue
    }
    if (/^---+$/.test(l)) { flushList(); out.push({ type: 'hr', lines: [] }); i++; continue }
    if ((m = l.match(/^>\s*(.*)$/))) {
      flushList()
      out.push({ type: 'blockquote', lines: [m[1]] })
      i++; continue
    }
    if ((m = l.match(/^[-*]\s+(.*)$/))) {
      if (listType !== 'ul') flushList()
      listType = 'ul'
      listLines.push(m[1])
      i++; continue
    }
    if ((m = l.match(/^\d+\.\s+(.*)$/))) {
      if (listType !== 'ol') flushList()
      listType = 'ol'
      listLines.push(m[1])
      i++; continue
    }
    if (l.trim() === '') { flushList(); i++; continue }
    flushList()
    out.push({ type: 'p', lines: [l] })
    i++
  }
  flushList()
  return out
}

export function renderMarkdownNodes(src: string): React.ReactNode {
  const blocks = parseBlocks(src)
  return (
    <>
      {blocks.map((b, idx) => {
        switch (b.type) {
          case 'h1':         return <h1 key={idx}>{renderInline(b.lines[0])}</h1>
          case 'h2':         return <h2 key={idx}>{renderInline(b.lines[0])}</h2>
          case 'h3':         return <h3 key={idx}>{renderInline(b.lines[0])}</h3>
          case 'hr':         return <hr key={idx} />
          case 'blockquote': return <blockquote key={idx}><p>{renderInline(b.lines[0])}</p></blockquote>
          case 'ul':         return <ul key={idx}>{b.lines.map((li, j) => <li key={j}>{renderInline(li)}</li>)}</ul>
          case 'ol':         return <ol key={idx}>{b.lines.map((li, j) => <li key={j}>{renderInline(li)}</li>)}</ol>
          case 'code': {
            // Show {{var}} chips inside code blocks too.
            const text = b.lines.join('\n')
            const parts = text.split(VAR_RE)
            return (
              <pre key={idx}>
                <code>
                  {parts.map((part, j) => {
                    const m = part.match(VAR_INNER)
                    return m
                      ? <span key={j} className="pb-var">{`{{${m[1]}}}`}</span>
                      : <React.Fragment key={j}>{part}</React.Fragment>
                  })}
                </code>
              </pre>
            )
          }
          case 'p':
          default:           return <p key={idx}>{renderInline(b.lines[0])}</p>
        }
      })}
    </>
  )
}
