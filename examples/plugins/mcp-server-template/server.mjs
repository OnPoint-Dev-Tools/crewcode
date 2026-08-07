#!/usr/bin/env node

// Minimal stdio MCP skeleton for template authors.
// Replace this with a real MCP SDK server before using it in production.
process.stdin.setEncoding('utf8')

process.stdin.on('data', chunk => {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'crewcode-local-context-template', version: '0.1.0' },
        },
      }) + '\n')
    }
  }
})
