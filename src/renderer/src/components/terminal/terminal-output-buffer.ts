const DEFAULT_FRAME_BUDGET = 64 * 1024
const DEFAULT_PENDING_LIMIT = 2_000_000

type ScheduleFrame = (callback: FrameRequestCallback) => number
type CancelFrame = (handle: number) => void

interface TerminalOutputBufferOptions {
  active?: boolean
  frameBudget?: number
  pendingLimit?: number
  scheduleFrame?: ScheduleFrame
  cancelFrame?: CancelFrame
}

/**
 * Frame-budgeted, backpressured output queue for xterm.
 *
 * Inactive terminal tabs stay mounted so their PTYs survive tab switches, but
 * xterm must not keep parsing and painting their output in the background. The
 * queue retains a bounded tail while inactive and drains it over animation
 * frames after activation. Waiting for xterm's write callback prevents a fast
 * PTY from building a second unbounded parser queue inside xterm.
 */
export class TerminalOutputBuffer {
  private chunks: string[] = []
  private headOffset = 0
  private pendingChars = 0
  private droppedChars = 0
  private active: boolean
  private disposed = false
  private writing = false
  private frame: number | null = null

  private readonly frameBudget: number
  private readonly pendingLimit: number
  private readonly scheduleFrame: ScheduleFrame
  private readonly cancelFrame: CancelFrame

  constructor(
    private readonly write: (data: string, done: () => void) => void,
    options: TerminalOutputBufferOptions = {},
  ) {
    this.active = options.active ?? true
    this.frameBudget = Math.max(1, options.frameBudget ?? DEFAULT_FRAME_BUDGET)
    this.pendingLimit = Math.max(this.frameBudget, options.pendingLimit ?? DEFAULT_PENDING_LIMIT)
    this.scheduleFrame = options.scheduleFrame ?? ((callback) => requestAnimationFrame(callback))
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))
  }

  enqueue(data: string): void {
    if (this.disposed || !data) return
    this.chunks.push(data)
    this.pendingChars += data.length
    this.trimPendingTail()
    this.schedule()
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return
    this.active = active
    if (!active && this.frame !== null) {
      this.cancelFrame(this.frame)
      this.frame = null
    }
    if (active) this.schedule()
  }

  dispose(): void {
    this.disposed = true
    if (this.frame !== null) this.cancelFrame(this.frame)
    this.frame = null
    this.chunks = []
    this.headOffset = 0
    this.pendingChars = 0
    this.droppedChars = 0
  }

  private trimPendingTail(): void {
    let excess = this.pendingChars - this.pendingLimit
    while (excess > 0 && this.chunks.length > 0) {
      const available = this.chunks[0]!.length - this.headOffset
      const remove = Math.min(excess, available)
      this.headOffset += remove
      this.pendingChars -= remove
      this.droppedChars += remove
      excess -= remove
      if (this.headOffset === this.chunks[0]!.length) {
        this.chunks.shift()
        this.headOffset = 0
      }
    }
  }

  private schedule(): void {
    if (this.disposed || !this.active || this.writing || this.frame !== null || this.pendingChars === 0) return
    this.frame = this.scheduleFrame(() => {
      this.frame = null
      this.drainFrame()
    })
  }

  private drainFrame(): void {
    if (this.disposed || !this.active || this.writing) return
    let budget = this.frameBudget
    const parts: string[] = []

    if (this.droppedChars > 0) {
      const notice = `\r\n\x1b[2;37m[${this.droppedChars.toLocaleString('en-US')} characters of hidden terminal output omitted]\x1b[0m\r\n`
      parts.push(notice)
      budget = Math.max(0, budget - notice.length)
      this.droppedChars = 0
    }

    while (budget > 0 && this.chunks.length > 0) {
      const head = this.chunks[0]!
      const available = head.length - this.headOffset
      const take = Math.min(budget, available)
      parts.push(head.slice(this.headOffset, this.headOffset + take))
      this.headOffset += take
      this.pendingChars -= take
      budget -= take
      if (this.headOffset === head.length) {
        this.chunks.shift()
        this.headOffset = 0
      }
    }

    const output = parts.join('')
    if (!output) return
    this.writing = true
    this.write(output, () => {
      this.writing = false
      this.schedule()
    })
  }
}
