import { statSync } from 'fs'
import { join, normalize, sep } from 'path'

type Entry = { ownerId: string; root: string; rel: string; mtime: number }

export class RemoteEditorFileWatch {
  private entries = new Map<string, Entry>()
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly emit: (ownerId: string, event: { root: string; rel: string }) => void) {}
  add(ownerId: string, root: string, rel: string): void {
    const target = normalize(join(root, rel)); const base = normalize(root)
    if (target !== base && !target.startsWith(base + sep)) return
    const key = `${ownerId}\0${target}`
    this.entries.set(key, { ownerId, root, rel, mtime: this.mtime(target) })
    if (!this.timer) this.timer = setInterval(() => this.poll(), 1_000)
  }
  remove(ownerId: string, root: string, rel: string): void { this.entries.delete(`${ownerId}\0${normalize(join(root, rel))}`); this.maybeStop() }
  removeOwner(ownerId: string): void { for (const [key, entry] of this.entries) if (entry.ownerId === ownerId) this.entries.delete(key); this.maybeStop() }
  stop(): void { this.entries.clear(); this.maybeStop() }
  private poll(): void { for (const entry of this.entries.values()) { const next = this.mtime(normalize(join(entry.root, entry.rel))); if (next >= 0 && next !== entry.mtime) { entry.mtime = next; this.emit(entry.ownerId, { root: entry.root, rel: entry.rel }) } } }
  private mtime(path: string): number { try { return statSync(path).mtimeMs } catch { return -1 } }
  private maybeStop(): void { if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = null } }
}
