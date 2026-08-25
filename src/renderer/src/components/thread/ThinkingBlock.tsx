import React, { useMemo, useState } from 'react'
import { chronologicalStreamSegments } from '../../streaming/stream-chunks'

interface ThinkingBlockProps {
  text:      string
  streaming: boolean
  chunks?:   string[]
}

export function ThinkingBlock({ text, streaming, chunks }: ThinkingBlockProps) {
  const [open, setOpen] = useState(streaming)
  const segments = useMemo(() => chronologicalStreamSegments(chunks, text), [chunks, text])

  return (
    <div className={`thinking${streaming ? ' streaming' : ''}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="-mx-1.5 flex max-w-full cursor-pointer appearance-none items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 text-left font-[inherit] text-cc-muted transition-colors duration-150 hover:bg-cc-hover hover:text-cc-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-cc-accent"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`shrink-0 ${streaming ? 'text-cc-ink' : 'text-cc-muted'}`}
          fill="currentColor"
        >
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        <span role="status" className="min-w-0 text-[13px] font-medium">
          {streaming ? (
            <span
              className="block truncate bg-clip-text text-transparent [animation:cc-shimmer-text_1.4s_linear_infinite]"
              style={{
                backgroundImage: 'linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)',
                backgroundSize: '200% 100%',
              }}
            >
              Thinking
            </span>
          ) : (
            <span className="block truncate text-cc-muted">Thinking</span>
          )}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 text-cc-muted transition-transform duration-300"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="relative mt-1 ml-[5px] min-w-0 border-l border-cc-line py-1 pl-4 sm:pl-5">
            <div
              className="flex min-w-0 flex-col gap-2 font-mono text-[11.5px] leading-relaxed text-cc-muted sm:text-xs"
              aria-live={streaming ? 'polite' : undefined}
            >
              {segments.map((segment, index) => (
                <div
                  className={`min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${index === segments.length - 1 ? 'text-cc-ink' : ''}`}
                  key={`${index}-${segment.slice(0, 16)}`}
                >
                  {segment}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
