#!/usr/bin/env node

import http from 'node:http'

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404)
    res.end('not found')
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  const json = JSON.parse(body || '{}')
  const prompt = json.messages?.at(-1)?.content ?? ''
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({
    choices: [{ message: { content: `local openai-compatible template received ${String(prompt).length} characters.` } }],
  }))
})

server.listen(4000, () => console.log('openai-compatible template listening on http://localhost:4000/v1/chat/completions'))
