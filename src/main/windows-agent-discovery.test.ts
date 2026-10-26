import { afterEach, describe, expect, it, vi } from 'vitest'
import { windowsAgentCandidates, detectWindowsAgentPath } from './windows-agent-discovery'

const { existsSync } = vi.hoisted(() => ({ existsSync: vi.fn((_path: unknown): boolean => false) }))
vi.mock('node:fs', () => ({ existsSync }))
afterEach(() => { existsSync.mockReset(); vi.unstubAllEnvs() })

const home = 'C:/Users/CLI User'

describe('Windows provider discovery', () => {
  it('finds native CLIs and npm shims with an empty inherited PATH', () => {
    const env = { PATH: '', APPDATA: 'D:/Roaming', LOCALAPPDATA: 'D:/Local' }
    expect(windowsAgentCandidates('claude', env, home)).toContain('C:\\Users\\CLI User\\.local\\bin\\claude.exe')
    expect(windowsAgentCandidates('crewcoder', env, home)).toContain('D:\\Roaming\\npm\\crewcoder.cmd')
    expect(windowsAgentCandidates('codex', env, home)).toContain('D:\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe')
  })

  it('honors quoted PATH entries and prefers native executables within each directory', () => {
    const paths = windowsAgentCandidates('codex', { Path: '"D:/CLI Tools";E:/bin' }, home)
    expect(paths.slice(0, 5)).toEqual([
      'D:\\CLI Tools\\codex.exe', 'D:\\CLI Tools\\codex.cmd',
      'D:\\CLI Tools\\codex.bat', 'D:\\CLI Tools\\codex', 'E:\\bin\\codex.exe',
    ])
    expect(paths.some(path => path.endsWith('.ps1'))).toBe(false)
  })

  it('uses conventional per-user locations when AppData variables are missing', () => {
    expect(windowsAgentCandidates('crewcoder', {}, home)).toContain('C:\\Users\\CLI User\\AppData\\Roaming\\npm\\crewcoder.cmd')
  })

  it('returns only observed files and null for a missing provider', () => {
    vi.stubEnv('PATH', 'D:/Tools')
    existsSync.mockImplementation(path => String(path) === 'D:\\Tools\\crewcoder.cmd')
    expect(detectWindowsAgentPath('crewcoder')).toBe('D:\\Tools\\crewcoder.cmd')
    expect(detectWindowsAgentPath('missing-provider')).toBeNull()
  })
})
