import type { ReactNode } from 'react'
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Laptop,
  RefreshCw,
  Settings,
  TerminalSquare,
} from 'lucide-react'
import { MobileBrand, useHubMobileDarkMode } from './MobileBrand'

export interface MobileRecentThread {
  scopeId: string
  tabId: string
  workspaceId: string
  title: string
  detail: string
  updatedAt: number
  status: 'running' | 'done' | 'saved'
  agentId?: string
}

export interface MobileMachineStats {
  worktrees: number | null
  agents: number | null
  running: number | null
  done: number | null
}

interface MobileMachineOverviewProps {
  machineName: string
  connected: boolean
  stats: MobileMachineStats
  recentThreads: MobileRecentThread[]
  loading?: boolean
  error?: string | null
  onBack: () => void
  onOpenSettings: () => void
  onRefresh: () => void
  onEnterCrewCode: (thread?: MobileRecentThread) => void
}

function StatCard({ icon, value, label }: { icon: ReactNode; value: number | null; label: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-cc-line bg-cc-surface p-3.5">
      <div className="mb-4 flex size-8 items-center justify-center rounded-lg bg-cc-field text-cc-muted">{icon}</div>
      <div className="text-2xl font-semibold tracking-tight text-cc-ink">{value ?? '—'}</div>
      <div className="mt-1 truncate font-mono text-[10px] font-semibold uppercase tracking-wider text-cc-muted">{label}</div>
    </div>
  )
}

function relativeTime(value: number): string {
  const elapsed = Math.max(0, Date.now() - value)
  if (elapsed < 60_000) return 'just now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function MobileMachineOverview({
  machineName,
  connected,
  stats,
  recentThreads,
  loading = false,
  error,
  onBack,
  onOpenSettings,
  onRefresh,
  onEnterCrewCode,
}: MobileMachineOverviewProps) {
  const isDark = useHubMobileDarkMode()

  return (
    <main data-theme={isDark ? 'dark' : 'light'} className="min-h-dvh bg-cc-canvas text-cc-ink">
      <div className="mx-auto min-h-dvh w-full max-w-md px-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between">
          <button
            type="button"
            aria-label="Back to desktops"
            className="flex size-11 items-center justify-center rounded-xl border border-cc-line bg-cc-surface text-cc-muted active:bg-cc-hover active:text-cc-ink"
            onClick={onBack}
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </button>
          <MobileBrand isDark={isDark} />
          <button
            type="button"
            aria-label="Open Hub settings"
            className="flex size-11 items-center justify-center rounded-xl border border-cc-line bg-cc-surface text-cc-muted active:bg-cc-hover active:text-cc-ink"
            onClick={onOpenSettings}
          >
            <Settings className="size-5" aria-hidden="true" />
          </button>
        </header>

        <section className="mt-10">
          <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-cc-muted">
            <span className={`size-2 rounded-full ${connected ? 'bg-cc-accent' : 'bg-cc-muted'}`} aria-hidden="true" />
            {connected ? 'Connected' : 'Connecting'}
          </div>
          <h1 className="mt-2 truncate text-4xl font-bold tracking-tight text-cc-ink">{machineName || 'Desktop'}</h1>
          <p className="mt-3 text-sm leading-6 text-cc-muted">Brain-local activity and recent work on this desktop.</p>
        </section>

        <section className="mt-7 rounded-xl border border-cc-line bg-cc-surface p-5" aria-label="Worktree count">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-4xl font-semibold tracking-tight text-cc-ink">{stats.worktrees ?? '—'}</div>
              <div className="mt-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-cc-muted">Worktrees</div>
            </div>
            <div className="flex size-12 items-center justify-center rounded-xl bg-cc-field text-cc-muted">
              <Laptop className="size-5" aria-hidden="true" />
            </div>
          </div>
        </section>

        <section className="mt-3 grid grid-cols-3 gap-2.5" aria-label="Agent activity">
          <StatCard icon={<Bot className="size-4" />} value={stats.agents} label="Agents" />
          <StatCard icon={<Clock3 className="size-4" />} value={stats.running} label="Running" />
          <StatCard icon={<Check className="size-4" />} value={stats.done} label="Done" />
        </section>

        <section className="mt-9">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-cc-muted">Recent threads</h2>
            <button
              type="button"
              className="-mt-2 flex min-h-11 items-center gap-2 rounded-lg border border-cc-line px-3 font-mono text-[10px] uppercase tracking-wider text-cc-muted active:bg-cc-hover active:text-cc-ink"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>
          </div>

          {error ? <div role="alert" className="mb-3 border border-cc-danger bg-cc-surface p-4 text-sm text-cc-danger">{error}</div> : null}

          {!error && loading && recentThreads.length === 0 ? (
            <div className="border border-cc-line bg-cc-surface p-5 font-mono text-xs text-cc-muted">Loading desktop activity…</div>
          ) : null}

          {!error && !loading && recentThreads.length === 0 ? (
            <div className="border border-cc-line bg-cc-surface p-5 text-sm text-cc-muted">No saved threads on this desktop yet.</div>
          ) : null}

          <div className="grid gap-3">
            {recentThreads.map(thread => (
              <button
                key={thread.scopeId}
                type="button"
                className="flex min-h-[78px] w-full items-center gap-3 rounded-xl border border-cc-line bg-cc-surface p-4 text-left active:bg-cc-hover"
                onClick={() => onEnterCrewCode(thread)}
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-cc-field text-cc-muted">
                  <TerminalSquare className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-cc-ink">{thread.title}</div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-cc-muted">
                    <span className={`size-1.5 shrink-0 rounded-full ${thread.status === 'running' ? 'bg-cc-accent' : 'bg-cc-muted'}`} aria-hidden="true" />
                    <span className="truncate">{thread.detail} · {relativeTime(thread.updatedAt)}</span>
                  </div>
                </div>
                <ChevronRight className="size-5 shrink-0 text-cc-muted" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>

        <button
          type="button"
          className="mt-8 min-h-14 w-full border border-cc-accent bg-cc-accent px-5 text-sm font-semibold text-white active:opacity-90"
          onClick={() => onEnterCrewCode()}
        >
          Open CrewCode
        </button>
      </div>
    </main>
  )
}
