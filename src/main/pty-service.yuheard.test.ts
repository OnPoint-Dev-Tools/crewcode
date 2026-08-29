import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  installWrapper: vi.fn(() => '/tmp/crewcode-yuheard-wrap/pane-1'),
  installHook: vi.fn(() => ({
    dir: '/tmp/crewcode-yuheard-wrap/pane-1',
    hookPath: '/tmp/crewcode-yuheard-wrap/pane-1/yuheard-hook.py',
    runtime: { cmd: '/usr/bin/python3', kind: 'python' as const },
  })),
  fishArgv: vi.fn(() => ['-C', 'yuheard-init']),
}))

vi.mock('node-pty', () => ({ spawn: mocks.spawn }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    // GitHub runners do not install Fish. Keep shell discovery out of this
    // file: pretend the first POSIX candidate exists so spawn stays Fish.
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      String(p) === '/usr/bin/fish' || actual.existsSync(p),
  }
})
vi.mock('./yuheard-wrapper', () => ({
  bashKeepWrapPrompt: vi.fn((dir: string) => `PATH=${dir}:$PATH`),
  codexNotifyArgv: vi.fn(() => ['-c', 'notify=[]']),
  executableBaseName: vi.fn(() => 'fish'),
  fishKeepWrapArgv: mocks.fishArgv,
  installYuHeardHook: mocks.installHook,
  installYuHeardWrapper: mocks.installWrapper,
  uninstallYuHeardWrapper: vi.fn(),
}))

import { PtyService, type PtyYuHeardServer } from './pty-service'

function fakeProc() {
  return {
    pid: 42,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  }
}

describe('PtyService YuHeard bundle boundary', () => {
  let cwd: string

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spawn.mockReturnValue(fakeProc())
    mocks.installWrapper.mockReturnValue('/tmp/crewcode-yuheard-wrap/pane-1')
    mocks.fishArgv.mockReturnValue(['-C', 'yuheard-init'])
    cwd = mkdtempSync(join(tmpdir(), 'pty-yuheard-'))
  })

  it('uses injected server access and statically imported wrappers for a Fish shell', () => {
    const notePaneSpawned = vi.fn()
    const server: PtyYuHeardServer = {
      getSocketPath: () => '/tmp/crewcode-yuheard.sock',
      notePaneSpawned,
      notePaneClosed: vi.fn(),
      noteSessionRunning: vi.fn(),
      isSessionActive: () => false,
      shouldAutoComplete: () => false,
      reportYuHeardFromProcess: () => 'applied',
    }
    const service = new PtyService(() => server)

    const result = service.create({
      paneId: 'pane-1',
      cwd,
      shell: 'fish',
      yuheard: true,
      autoWrap: true,
      wrapAgentIds: ['codex', 'claude'],
    })

    expect(result.ok).toBe(true)
    expect(notePaneSpawned).toHaveBeenCalledWith('pane-1', cwd)
    expect(mocks.installWrapper).toHaveBeenCalledWith(
      'pane-1',
      ['codex', 'claude'],
      { socketPath: '/tmp/crewcode-yuheard.sock' },
    )
    expect(mocks.fishArgv).toHaveBeenCalledWith(
      '/tmp/crewcode-yuheard-wrap/pane-1',
      [],
      ['codex', 'claude'],
    )
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/usr/bin/fish',
      ['-C', 'yuheard-init'],
      expect.objectContaining({
        env: expect.objectContaining({
          YUHEARD_PANE_ID: 'pane-1',
          YUHEARD_SOCKET: '/tmp/crewcode-yuheard.sock',
          PATH: expect.stringMatching(/^\/tmp\/crewcode-yuheard-wrap\/pane-1:/),
        }),
      }),
    )
  })

  it('uses exact hooks instead of PTY redraw heuristics for Codex prompts', () => {
    let onData: ((data: string) => void) | undefined
    const proc = fakeProc()
    proc.onData.mockImplementation((listener: (data: string) => void) => {
      onData = listener
    })
    mocks.spawn.mockReturnValue(proc)

    const reportYuHeardFromProcess = vi.fn(() => 'applied' as const)
    const server: PtyYuHeardServer = {
      getSocketPath: () => '/tmp/crewcode-yuheard.sock',
      notePaneSpawned: vi.fn(),
      notePaneClosed: vi.fn(),
      noteSessionRunning: vi.fn(),
      isSessionActive: () => true,
      shouldAutoComplete: () => false,
      reportYuHeardFromProcess,
    }
    const service = new PtyService(() => server)
    service.create({
      paneId: 'pane-1',
      cwd,
      shell: 'fish',
      yuheard: true,
      autoWrap: true,
      wrapAgentIds: ['codex'],
    })

    service.write('pane-1', 'codex\r')
    onData?.(`starting codex${'x'.repeat(200)}\x07`)
    expect(reportYuHeardFromProcess).not.toHaveBeenCalled()

    service.write('pane-1', 'explain this code\r')
    onData?.('finished reply\x07')
    expect(reportYuHeardFromProcess).not.toHaveBeenCalled()
  })

  it('keeps PTY completion fallback for agents without an exact hook', () => {
    let onData: ((data: string) => void) | undefined
    const proc = fakeProc()
    proc.onData.mockImplementation((listener: (data: string) => void) => {
      onData = listener
    })
    mocks.spawn.mockReturnValue(proc)

    const reportYuHeardFromProcess = vi.fn(() => 'applied' as const)
    const server: PtyYuHeardServer = {
      getSocketPath: () => '/tmp/crewcode-yuheard.sock',
      notePaneSpawned: vi.fn(),
      notePaneClosed: vi.fn(),
      noteSessionRunning: vi.fn(),
      isSessionActive: () => true,
      shouldAutoComplete: () => false,
      reportYuHeardFromProcess,
    }
    const service = new PtyService(() => server)
    service.create({
      paneId: 'pane-1',
      cwd,
      shell: 'fish',
      yuheard: true,
      autoWrap: true,
      wrapAgentIds: ['claude'],
    })

    service.write('pane-1', 'claude\r')
    onData?.('starting claude\x07')
    expect(reportYuHeardFromProcess).not.toHaveBeenCalled()

    service.write('pane-1', 'explain this code\r')
    onData?.('finished reply\x07')
    expect(reportYuHeardFromProcess).toHaveBeenCalledWith(expect.objectContaining({
      pane_id: 'pane-1',
      state: 'complete',
      source: 'pty-bell',
    }))
  })
})
