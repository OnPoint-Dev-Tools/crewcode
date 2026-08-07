import React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '../code/CodeBlock'

interface MarkdownProps {
  text: string
  onOpenLink?: (url: string) => void
}

function createComponents(onOpenLink?: (url: string) => void): Components {
  return {
    p:          ({ children }) => <p className="md-p">{children}</p>,
    h1:         ({ children }) => <h1 className="md-h1">{children}</h1>,
    h2:         ({ children }) => <h2 className="md-h2">{children}</h2>,
    h3:         ({ children }) => <h3 className="md-h3">{children}</h3>,
    h4:         ({ children }) => <h4 className="md-h4">{children}</h4>,
    ul:         ({ children }) => <ul className="md-ul">{children}</ul>,
    ol:         ({ children }) => <ol className="md-ol">{children}</ol>,
    li:         ({ children }) => <li className="md-li">{children}</li>,
    blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
    hr:         () => <hr className="md-hr" />,
    a: ({ href, children }) => (
      <a
        className="md-a"
        href={href}
        onClick={(e) => {
          if (!href || !onOpenLink) return
          e.preventDefault()
          onOpenLink(href)
        }}
        target={onOpenLink ? undefined : '_blank'}
        rel={onOpenLink ? undefined : 'noopener noreferrer'}
      >
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="md-table-wrap"><table className="md-table">{children}</table></div>
    ),
    thead: ({ children }) => <thead className="md-thead">{children}</thead>,
    tbody: ({ children }) => <tbody className="md-tbody">{children}</tbody>,
    tr:    ({ children }) => <tr className="md-tr">{children}</tr>,
    th:    ({ children }) => <th className="md-th">{children}</th>,
    td:    ({ children }) => <td className="md-td">{children}</td>,
    strong: ({ children }) => <strong className="md-strong">{children}</strong>,
    em:     ({ children }) => <em className="md-em">{children}</em>,
    // ReactMarkdown normally wraps fenced code in <pre>; CodeBlock owns that
    // element so the safe async Shiki renderer never creates nested pre tags.
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, ...props }) => {
      const code = String(children)
      const isBlock = /language-/.test(className || '') || code.includes('\n')
      if (isBlock) {
        const lang = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]
        return <CodeBlock code={code.replace(/\n$/, '')} lang={lang} className="md-code-highlight" />
      }
      return <code className="md-code-inline" {...props}>{children}</code>
    },
  }
}

export function Markdown({ text, onOpenLink }: MarkdownProps) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={createComponents(onOpenLink)}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
