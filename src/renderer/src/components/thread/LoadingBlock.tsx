import { useState, useEffect, useRef } from 'react'
import { SwishSpinner } from 'react-spinners-kit'

interface LoadingBlockProps {
  text:      string
  streaming: boolean
  time:      string
  status?:   string | null
}

const TERMS = [
  'Thinking',
  'Coding',
  'Programming',
  'Scripting',
  'Refactoring',
  'Architecting',
  'Debugging',
  'Testing',
  'Linting',
  'Profiling',
  'Benchmarking',
  'Compiling',
  'Deploying',
  'Hosting',
  'Versioning',
  'Patching',
  'Caching',
  'Parsing',
  'Indexing',
  'Routing',
  'Mocking',
  'Querying',
  'Serializing',
  'Encrypting',
  'Hashing',
  'Scraping',
  'Mapping',
  'Streaming',
  'Branching',
  'Merging',
  'Forking',
  'Pairing',
  'Shipping',
  'Scrumming',
  'Looping',
  'Threading',
  'Booting',
  'Rendering',
  'Queueing',
  'Scoping',
  'Polling',
  'Bundling',
  'Minifying',
  'Hydrating',
  'Fetching',
  'Styling',
  'Scaffolding',
  'Templating',
  'Pre-rendering',
  'Sanitizing',
  'Containerizing',
  'Orchestrating',
  'Provisioning',
  'Monitoring',
  'Logging',
  'Automating',
  'Throttling',
  'Clustering',
  'Hardening',
] as const

// Spinner uses the requested kit while the cycling TERMS word stays as live status.
export function LoadingBlock({ text, streaming, time, status }: LoadingBlockProps) {
  const [termIndex, setTermIndex] = useState(0)
  const prevStreamingRef = useRef(streaming)

  useEffect(() => {
    if (streaming && !prevStreamingRef.current) {
      setTermIndex(0)
    }
    prevStreamingRef.current = streaming
  }, [streaming])

  useEffect(() => {
    if (!streaming) return
    const timer = setInterval(() => {
      setTermIndex(prev => (prev + 1) % TERMS.length)
    }, 1200)
    return () => clearInterval(timer)
  }, [streaming])

  return (
    <div className={`loading-block ${streaming ? 'active' : ''}`}>
      <div className="loading-visual">
        <div aria-hidden="true">
          <SwishSpinner size={30} frontColor="#00ff89" backColor="#4b4c56" loading={streaming} />
        </div>
        <div className="loading-word">{TERMS[termIndex]}</div>
      </div>
      {status ? <div className="loading-status">{status}</div> : null}
      <div className="loading-ts">{time}</div>
    </div>
  )
}
