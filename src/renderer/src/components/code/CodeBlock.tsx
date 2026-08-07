import React, { useEffect, useState, useRef } from 'react'
import { createCssVariablesTheme, createHighlighter, type Highlighter, type ThemedToken, type BundledLanguage } from 'shiki'
import { Icon } from '../ui/Icon'

// Singleton highlighter — Shiki's bundle isn't free, so load once and share
// across every CodeBlock instance.
let highlighterPromise: Promise<Highlighter> | null = null
const loadedLangs = new Set<string>()

const CREWCODE_SYNTAX_THEME_NAME = 'crewcode-syntax'
const CREWCODE_SYNTAX_THEME = createCssVariablesTheme({
  name: CREWCODE_SYNTAX_THEME_NAME,
  variablePrefix: '--syntax-',
})

const SUPPORTED_LANGS = new Set([
  'text','bash','sh','zsh','fish','ts','tsx','js','jsx','json','yaml','toml',
  'python','rust','go','java','kotlin','ruby','php','swift','csharp','cpp','c',
  'html','css','scss','sass','markdown','mdx','xml','sql','docker','ini',
])

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'js', javascript: 'js', mjs: 'js',
  typescript: 'ts', mts: 'ts', cts: 'ts',
  py: 'python', rb: 'ruby', rs: 'rust', cs: 'csharp', 'c++': 'cpp',
  shell: 'bash', console: 'bash', yml: 'yaml', md: 'markdown',
  plaintext: 'text', txt: 'text',
}

const MAX_HIGHLIGHT_CHARS = 80_000

export function normalizeCodeLanguage(lang?: string): string {
  const normalized = (lang || 'text').trim().toLowerCase()
  return LANGUAGE_ALIASES[normalized] ?? normalized
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [CREWCODE_SYNTAX_THEME],
      langs:  ['bash','ts','tsx','js','jsx','json','python','rust','go','markdown','text'],
    })
  }
  return highlighterPromise
}

async function ensureLang(h: Highlighter, lang: string): Promise<string> {
  const normalized = normalizeCodeLanguage(lang)
  if (!SUPPORTED_LANGS.has(normalized)) return 'text'
  if (loadedLangs.has(normalized)) return normalized
  try {
    await h.loadLanguage(normalized as Parameters<typeof h.loadLanguage>[0])
    loadedLangs.add(normalized)
    return normalized
  } catch {
    return 'text'
  }
}

interface CodeBlockProps {
  code:  string
  lang?: string
  className?: string
}

/**
 * Syntax-highlighted code block. Builds React nodes directly from Shiki's
 * tokens (no innerHTML) so we stay safe against XSS even if upstream output
 * is unsanitized.
 */
export function CodeBlock({ code, lang, className }: CodeBlockProps) {
  const tooLargeToHighlight = code.length > MAX_HIGHLIGHT_CHARS
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const copyCode = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1400)
    }).catch(() => { /* clipboard unavailable */ })
  }

  const copyButton = (
    <button
      type="button"
      className={`code-copy ${copied ? 'copied' : ''}`}
      onClick={copyCode}
      title={copied ? 'copied' : 'copy code'}
      aria-label={copied ? 'copied' : 'copy code'}
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )

  useEffect(() => {
    if (tooLargeToHighlight) { setTokens(null); return }
    alive.current = true
    let cancelled = false
    ;(async () => {
      try {
        const h         = await getHighlighter()
        const resolved  = await ensureLang(h, lang || 'text')
        if (cancelled || !alive.current) return
        const result    = h.codeToTokens(code, { lang: resolved as BundledLanguage, theme: CREWCODE_SYNTAX_THEME_NAME })
        if (cancelled || !alive.current) return
        setTokens(result.tokens)
      } catch {
        if (!cancelled && alive.current) setTokens(null)
      }
    })()
    return () => { cancelled = true; alive.current = false }
  }, [code, lang, tooLargeToHighlight])

  if (tooLargeToHighlight || !tokens) {
    return (
      <div className="code-block-wrap">
        {copyButton}
        <pre className={`shiki-block-fallback ${className ?? ''}`}>{code}</pre>
      </div>
    )
  }
  return (
    <div className="code-block-wrap">
      {copyButton}
      <pre className={`shiki-block ${className ?? ''}`}>
        <code>
          {tokens.map((line, i) => (
            <React.Fragment key={i}>
              {line.length === 0
                ? <span> </span>
                : line.map((tok, j) => (
                    <span key={j} style={{ color: tok.color }}>{tok.content}</span>
                  ))}
              {'\n'}
            </React.Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}
