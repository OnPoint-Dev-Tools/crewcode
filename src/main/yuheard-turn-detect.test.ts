import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  YuHeardTurnDetector,
  YUHEARD_TURN_IDLE_MS,
  YUHEARD_TURN_MIN_BYTES,
  applyPtyKeystroke,
  outputLooksLikeBell,
  submittedAgentCommand,
  submittedLineLooksLikeAgent,
} from './yuheard-turn-detect'

describe('outputLooksLikeBell', () => {
  it('matches BEL and attention OSC sequences', () => {
    expect(outputLooksLikeBell('hello\x07')).toBe(true)
    expect(outputLooksLikeBell('\x1b]9;done\x07')).toBe(true)
    expect(outputLooksLikeBell('\x1b]777;notify;title;body')).toBe(true)
    expect(outputLooksLikeBell('just text')).toBe(false)
    expect(outputLooksLikeBell('\x1b]0;title')).toBe(false)
  })
})

describe('YuHeardTurnDetector', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires immediately on BEL', () => {
    const complete = vi.fn()
    const detector = new YuHeardTurnDetector(complete)
    detector.onSubmit('pn-1')
    detector.onData('pn-1', 'ready\x07')
    expect(complete).toHaveBeenCalledWith('pn-1', 'pty-bell')
    detector.clear('pn-1')
  })

  it('does not idle-complete below the output floor', () => {
    vi.useFakeTimers()
    const complete = vi.fn()
    const detector = new YuHeardTurnDetector(complete)
    detector.onSubmit('pn-1')
    detector.onData('pn-1', 'hi')
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS + 50)
    expect(complete).not.toHaveBeenCalled()
    detector.clear('pn-1')
  })

  it('idle-completes after a large burst goes quiet', () => {
    vi.useFakeTimers()
    const complete = vi.fn()
    const detector = new YuHeardTurnDetector(complete)
    detector.onSubmit('pn-1')
    detector.onData('pn-1', 'x'.repeat(YUHEARD_TURN_MIN_BYTES))
    expect(complete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS - 100)
    expect(complete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(complete).toHaveBeenCalledWith('pn-1', 'pty-idle')
    detector.clear('pn-1')
  })

  it('resets the idle window when more output arrives', () => {
    vi.useFakeTimers()
    const complete = vi.fn()
    const detector = new YuHeardTurnDetector(complete)
    detector.onSubmit('pn-1')
    detector.onData('pn-1', 'x'.repeat(YUHEARD_TURN_MIN_BYTES))
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS - 100)
    detector.onData('pn-1', 'more')
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS - 100)
    expect(complete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(complete).toHaveBeenCalledTimes(1)
    detector.clear('pn-1')
  })

  it('ignores CSI-only TUI redraws so a spinner does not reset idle', () => {
    vi.useFakeTimers()
    const complete = vi.fn()
    const detector = new YuHeardTurnDetector(complete)
    detector.onSubmit('pn-1')
    detector.onData('pn-1', 'x'.repeat(YUHEARD_TURN_MIN_BYTES))
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS - 100)
    detector.onData('pn-1', '\x1b[0m\x1b[1;1H\x1b[K')
    vi.advanceTimersByTime(200)
    expect(complete).toHaveBeenCalledWith('pn-1', 'pty-idle')
    detector.clear('pn-1')
  })

  it('can fire a second turn after a new burst', () => {
    vi.useFakeTimers()
    const complete = vi.fn()
    const detector = new YuHeardTurnDetector(complete)
    detector.onSubmit('pn-1')
    detector.onData('pn-1', 'a'.repeat(YUHEARD_TURN_MIN_BYTES))
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS + 10)
    detector.onSubmit('pn-1')
    detector.onData('pn-1', 'b'.repeat(YUHEARD_TURN_MIN_BYTES))
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS + 10)
    expect(complete).toHaveBeenCalledTimes(2)
    detector.clear('pn-1')
  })

  it('ignores initial agent TUI output until a prompt is submitted', () => {
    vi.useFakeTimers()
    const complete = vi.fn()
    const detector = new YuHeardTurnDetector(complete)
    detector.onAgentLaunch('pn-1')
    detector.onData('pn-1', `starting codex${'x'.repeat(YUHEARD_TURN_MIN_BYTES)}\x07`)
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS + 50)
    expect(complete).not.toHaveBeenCalled()

    detector.onSubmit('pn-1')
    detector.onData('pn-1', `reply${'x'.repeat(YUHEARD_TURN_MIN_BYTES)}`)
    vi.advanceTimersByTime(YUHEARD_TURN_IDLE_MS + 50)
    expect(complete).toHaveBeenCalledWith('pn-1', 'pty-idle')
    detector.clear('pn-1')
  })
})

describe('submittedLineLooksLikeAgent', () => {
  const cmds = ['claude', 'codex', 'grok'] as const

  it('matches a bare agent command', () => {
    expect(submittedLineLooksLikeAgent('codex', cmds)).toBe(true)
    expect(submittedLineLooksLikeAgent('  claude --dangerously-skip-permissions', cmds)).toBe(true)
  })

  it('matches an absolute path and skips env assignments', () => {
    expect(submittedLineLooksLikeAgent('/usr/bin/codex', cmds)).toBe(true)
    expect(submittedLineLooksLikeAgent('FOO=1 sudo grok', cmds)).toBe(true)
  })

  it('returns the matched agent identity', () => {
    expect(submittedAgentCommand('/usr/bin/codex --resume', cmds)).toBe('codex')
    expect(submittedAgentCommand('FOO=1 sudo grok', cmds)).toBe('grok')
    expect(submittedAgentCommand('echo codex', cmds)).toBeNull()
  })

  it('does not match agent names later in a prompt', () => {
    expect(submittedLineLooksLikeAgent('echo codex', cmds)).toBe(false)
    expect(submittedLineLooksLikeAgent('ls', cmds)).toBe(false)
    expect(submittedLineLooksLikeAgent('', cmds)).toBe(false)
  })
})

describe('applyPtyKeystroke', () => {
  it('submits on enter and honors backspace', () => {
    let state = applyPtyKeystroke('', 'codx')
    state = applyPtyKeystroke(state.buffer, '\x7fex\r')
    expect(state.submitted).toEqual(['codex'])
    expect(state.buffer).toBe('')
  })
})
