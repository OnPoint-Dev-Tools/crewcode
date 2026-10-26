import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnAgentProcess } from './agent-spawn'

const { spawn, execRemoteStream } = vi.hoisted(() => ({ spawn: vi.fn(() => ({})), execRemoteStream: vi.fn() }))
vi.mock('child_process', () => ({ spawn }))
vi.mock('../remote/ssh-pool', () => ({ execRemoteStream }))
afterEach(() => { vi.restoreAllMocks(); spawn.mockClear() })

describe('local agent spawning', () => {
  it('routes Windows npm launchers through cmd.exe', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await spawnAgentProcess({ command: 'C:/CLI Tools/crewcoder.cmd', args: ['acp'], cwd: 'C:/project' })
    expect(spawn).toHaveBeenCalledWith(expect.stringMatching(/cmd.exe$/i),
      ['/d', '/c', 'C:/CLI Tools/crewcoder.cmd', 'acp'],
      expect.objectContaining({ cwd: 'C:/project', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))
  })

  it('launches native Windows executables directly', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await spawnAgentProcess({ command: 'C:/bin/codex.exe', args: ['app-server'], cwd: 'C:/project' })
    expect(spawn).toHaveBeenCalledWith('C:/bin/codex.exe', ['app-server'], expect.any(Object))
  })

  it('preserves direct Unix spawning', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await spawnAgentProcess({ command: '/usr/bin/crewcoder', args: ['acp'], cwd: '/project' })
    expect(spawn).toHaveBeenCalledWith('/usr/bin/crewcoder', ['acp'], expect.any(Object))
  })
})
