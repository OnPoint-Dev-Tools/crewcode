import type { ReactNode } from 'react'
import {
  ChevronRight,
  Laptop,
  RefreshCw,
  Settings,
  Radio,
} from 'lucide-react'
import { MobileBrand, useHubMobileDarkMode } from './MobileBrand'

export interface MobileHubMachine {
  id: string
  name: string
  status: 'online' | 'offline' | 'revoked'
  platform: string | null
  version: string | null
  lastSeenAt: number | null
}

interface StatCardProps {
  icon: ReactNode
  value: string | number
  label: string
}

interface MobileDashboardProps {
  username: string
  machines: MobileHubMachine[]
  loading?: boolean
  error?: string | null
  onOpenMachine: (machineId: string) => void
  onOpenHubSettings: () => void
  onRefresh: () => void
}

function StatCard({ icon, value, label }: StatCardProps) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-cc-line bg-cc-surface p-4">
      <div className="mb-5 flex size-8 items-center justify-center rounded-lg bg-cc-field text-cc-muted">
        {icon}
      </div>
      <div className="text-2xl font-semibold tracking-tight text-cc-ink">{value}</div>
      <div className="mt-1 truncate font-mono text-[10px] font-semibold uppercase tracking-wider text-cc-muted">
        {label}
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-cc-muted">
      {children}
    </h2>
  )
}

function lastSeenLabel(value: number | null): string {
  if (!value) return 'Never connected'
  const elapsed = Math.max(0, Date.now() - value)
  if (elapsed < 60_000) return 'Seen just now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `Seen ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Seen ${hours}h ago`
  return `Seen ${Math.floor(hours / 24)}d ago`
}

export default function CrewCodeMobileDashboard({
  username,
  machines,
  loading = false,
  error,
  onOpenMachine,
  onOpenHubSettings,
  onRefresh,
}: MobileDashboardProps) {
  const isDark = useHubMobileDarkMode()
  const activeMachines = machines.filter(machine => machine.status !== 'revoked')
  const online = activeMachines.filter(machine => machine.status === 'online').length
  const offline = activeMachines.length - online

  return (
    <main data-theme={isDark ? 'dark' : 'light'} className="min-h-dvh bg-cc-canvas text-cc-ink">
      <div className="mx-auto min-h-dvh w-full max-w-md px-5 pb-10 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between">
          <MobileBrand isDark={isDark} />
          <button
            type="button"
            aria-label="Open Hub settings"
            className="flex size-11 items-center justify-center rounded-xl border border-cc-line bg-cc-surface text-cc-muted transition-colors active:bg-cc-hover active:text-cc-ink"
            onClick={onOpenHubSettings}
          >
            <Settings className="size-5" aria-hidden="true" />
          </button>
        </header>

        <section className="mt-14">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-cc-muted">Hub mobile</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-cc-ink">
            Welcome back{username ? `, ${username}` : ''}
          </h1>
          <p className="mt-3 text-sm leading-6 text-cc-muted">Choose an online Brain to open its CrewCode workspace.</p>
        </section>

        <section className="mt-8" aria-label="Machine status summary">
          <div className="grid grid-cols-3 gap-2.5">
            <StatCard icon={<Laptop className="size-4" />} value={activeMachines.length} label="Desktops" />
            <StatCard icon={<Radio className="size-4" />} value={online} label="Online" />
            <StatCard icon={<Laptop className="size-4" />} value={offline} label="Offline" />
          </div>
        </section>

        <section className="mt-9">
          <div className="mb-3 flex items-center justify-between">
            <SectionLabel>Desktops</SectionLabel>
            <button
              type="button"
              className="-mt-3 flex min-h-11 items-center gap-2 rounded-lg border border-cc-line bg-transparent px-3 font-mono text-[10px] uppercase tracking-wider text-cc-muted active:bg-cc-hover active:text-cc-ink"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>
          </div>

          {error ? (
            <div role="alert" className="border border-cc-danger bg-cc-surface p-4 text-sm text-cc-danger">{error}</div>
          ) : null}

          {!error && loading && activeMachines.length === 0 ? (
            <div className="border border-cc-line bg-cc-surface p-5 font-mono text-xs text-cc-muted">Loading enrolled desktops…</div>
          ) : null}

          {!error && !loading && activeMachines.length === 0 ? (
            <div className="border border-cc-line bg-cc-surface p-5">
              <p className="m-0 text-sm text-cc-ink">No desktops are enrolled yet.</p>
              <button type="button" className="mt-4 min-h-11 border border-cc-accent bg-cc-accent px-4 text-sm font-semibold text-white" onClick={onOpenHubSettings}>
                Manage Hub devices
              </button>
            </div>
          ) : null}

          <div className="grid gap-3">
            {activeMachines.map(machine => {
              const isOnline = machine.status === 'online'
              return (
                <button
                  key={machine.id}
                  type="button"
                  disabled={!isOnline}
                  onClick={() => onOpenMachine(machine.id)}
                  className="flex min-h-[82px] w-full items-center gap-4 rounded-xl border border-cc-line bg-cc-surface p-4 text-left transition-colors enabled:active:bg-cc-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-cc-field text-cc-ink">
                    <Laptop className="size-6" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold text-cc-ink">{machine.name}</div>
                    <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[10px] text-cc-muted">
                      <span className={`size-2 shrink-0 rounded-full ${isOnline ? 'bg-cc-accent' : 'bg-cc-muted'}`} aria-hidden="true" />
                      <span className="truncate">
                        {isOnline ? 'Online' : lastSeenLabel(machine.lastSeenAt)}
                        {machine.platform ? ` · ${machine.platform}` : ''}
                      </span>
                    </div>
                  </div>
                  {isOnline ? <ChevronRight className="size-5 shrink-0 text-cc-muted" aria-hidden="true" /> : null}
                </button>
              )
            })}
          </div>
        </section>

        <section className="mt-9">
          <SectionLabel>Hub</SectionLabel>
          <button
            type="button"
            className="flex min-h-14 w-full items-center justify-between border border-cc-line bg-cc-surface px-4 text-left text-sm font-semibold text-cc-ink active:bg-cc-hover"
            onClick={onOpenHubSettings}
          >
            Manage devices and account
            <ChevronRight className="size-5 text-cc-muted" aria-hidden="true" />
          </button>
        </section>
      </div>
    </main>
  )
}
