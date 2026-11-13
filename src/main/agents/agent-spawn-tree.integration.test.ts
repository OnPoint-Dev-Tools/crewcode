import { describe, expect, it, vi } from 'vitest'
import { spawnAgentProcess, type AgentProc } from './agent-spawn'

vi.mock('../remote/ssh-pool', () => ({ execRemoteStream: vi.fn() }))

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('owned Windows runtime termination', () => {
  it.skipIf(process.platform !== 'win32')('terminates one runtime and its child while leaving a sibling runtime alive', async () => {
    const roots: Array<{ proc: AgentProc; closed: Promise<void> }> = []
    const children: number[] = []
    const fixture = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"
    try {
      for (let index = 0; index < 2; index++) {
        const { proc } = await spawnAgentProcess({ command: process.execPath, args: ['-e', fixture], cwd: process.cwd() })
        const closed = new Promise<void>(resolve => { proc.on('close', () => resolve()) })
        roots.push({ proc, closed })
        const child = await new Promise<number>((resolve, reject) => {
          let output = ''
          proc.on('error', reject)
          proc.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString()
            if (!output.includes('\n')) return
            const pid = Number(output.trim())
            if (!Number.isInteger(pid) || pid <= 0) reject(new Error('Invalid fixture child PID'))
            else resolve(pid)
          })
        })
        children.push(child)
      }
      expect(children.every(alive)).toBe(true)
      roots[0]!.proc.kill()
      await roots[0]!.closed
      await vi.waitFor(() => expect(alive(children[0]!)).toBe(false), { timeout: 5_000 })
      expect(alive(roots[1]!.proc.pid!)).toBe(true)
      expect(alive(children[1]!)).toBe(true)
    } finally {
      for (const root of roots) root.proc.kill()
      await Promise.all(roots.map(root => root.closed))
    }
  }, 15_000)
})
