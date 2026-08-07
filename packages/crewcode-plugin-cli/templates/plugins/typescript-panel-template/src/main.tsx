import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { crewcode, type CrewCodePluginContext } from './crewcode-api'
import './style.css'

function App() {
  const [ctx, setCtx] = useState<CrewCodePluginContext | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [status, setStatus] = useState('waiting for CrewCode context…')

  useEffect(() => crewcode.onContext(next => {
    setCtx(next)
    setStatus(next.workspace ? `connected to ${next.workspace.name}` : 'no workspace')
    crewcode.workspace.listFiles()
      .then(result => setFiles(result.files.slice(0, 50)))
      .catch(err => setStatus(err.message))
  }), [])

  return (
    <main>
      <header>
        <div>
          <h1>TypeScript CrewCode Plugin</h1>
          <p>{status}</p>
        </div>
        <code>{ctx?.permissions.join(', ') || 'no permissions'}</code>
      </header>
      <section>
        <h2>first 50 workspace files</h2>
        <ul>
          {files.map(file => <li key={file}>{file}</li>)}
        </ul>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
