#!/usr/bin/env node
// yuheard — CLI for the YuHeard terminal agent-done channel.
//
// Subcommands:
//   pane-id                    Print $YUHEARD_PANE_ID (or "(unset)").
//   socket                     Print the YuHeard socket path.
//   running [message]          Report 'running' for the calling pane.
//   complete [message]         Report 'complete' for the calling pane.
//   --help                     Show this help.
//
// Env:
//   YUHEARD_PANE_ID            Set by CrewCode when it spawns a pty pane.
//                              The CLI sends this verbatim.
//   YUHEARD_SOCKET             Override the default socket path
//                              (~/.crewcode/yuheard.sock).
//
// Exit codes:
//   0   ok
//   1   socket error / no pane for cwd
//   2   bad arguments
//
// See docs/yuheard.md for the protocol and integration patterns.

import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const sub = args[0]
const SOCKET = process.env.YUHEARD_SOCKET
  ?? path.join(os.homedir(), '.crewcode', 'yuheard.sock')

function send(line, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET)
    let buf = ''
    let settled = false
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      sock.destroy()
      reject(new Error(`socket timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    sock.on('data', d => { buf += d.toString('utf8') })
    sock.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve(buf.trim())
    })
    sock.on('error', e => {
      if (settled) return
      settled = true
      clearTimeout(t)
      reject(e)
    })
    sock.write(line + '\n')
    sock.end()
  })
}

function reportLine(state, message) {
  return JSON.stringify({
    pane_id: process.env.YUHEARD_PANE_ID ?? '',
    state,
    source: 'yuheard-cli',
    message,
    ts: Date.now(),
  })
}

async function resolvePaneId() {
  if (process.env.YUHEARD_PANE_ID) return process.env.YUHEARD_PANE_ID
  const cwd = process.cwd()
  const lookupLine = JSON.stringify({ method: 'pane-id-lookup', cwd })
  const reply = await send(lookupLine)
  let parsed
  try { parsed = JSON.parse(reply) } catch { throw new Error(`invalid server reply: ${reply}`) }
  if (!parsed.ok) throw new Error(parsed.error ?? 'lookup failed')
  return parsed.paneId
}

function help() {
  process.stdout.write(`Usage: yuheard <subcommand> [args]

  pane-id                    Print $YUHEARD_PANE_ID (or "(unset)").
  socket                     Print the YuHeard socket path.
  running [message]          Report running for the calling shell's pane.
  complete [message]         Report complete for the calling shell's pane.
  --help                     Show this help.

Env:
  YUHEARD_PANE_ID            Set by CrewCode when it spawns a pty pane.
  YUHEARD_SOCKET             Override default (~/.crewcode/yuheard.sock).

Exit codes:
  0   ok      1   error      2   bad arguments
`)
}

async function main() {
  switch (sub) {
    case 'pane-id':
      process.stdout.write(`${process.env.YUHEARD_PANE_ID ?? '(unset)'}\n`)
      return
    case 'socket':
      process.stdout.write(`${SOCKET}\n`)
      return
    case '--help':
    case '-h':
    case undefined:
      help()
      return
    case 'running':
    case 'complete': {
      const message = args.slice(1).join(' ').trim() || undefined
      const paneId = await resolvePaneId()
      const line = reportLine(sub, message).replace(
        '"pane_id":""',
        `"pane_id":"${paneId.replace(/"/g, '\\"')}"`,
      )
      const reply = await send(line)
      process.stdout.write(`${reply}\n`)
      return
    }
    default:
      process.stderr.write(`yuheard: unknown subcommand "${sub}"\n`)
      help()
      process.exitCode = 2
  }
}

main().catch(err => {
  process.stderr.write(`yuheard: ${err?.message ?? String(err)}\n`)
  process.exit(1)
})
