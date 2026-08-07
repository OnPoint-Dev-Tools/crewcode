import http from 'node:http'

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/agent') {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body || '{}')
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    text: [
      'Company HTTP Agent template response.',
      '',
      `cwd: ${input.cwd ?? 'unknown'}`,
      `model: ${input.model ?? 'default'}`,
      '',
      `prompt length: ${String(input.prompt ?? '').length}`,
    ].join('\n')
  }))
})

server.listen(8787, () => {
  console.log('company agent template listening on http://localhost:8787/agent')
})
