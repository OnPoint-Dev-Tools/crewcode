import { useEffect, useState } from 'react'
import {
  RobotIcon, ChatsCircleIcon, GitForkIcon, GitBranchIcon, FolderPlusIcon,
  ArrowRightIcon, ArrowLeftIcon, RocketLaunchIcon, CheckFatIcon, UsersThreeIcon, SlidersHorizontalIcon, type Icon,
} from '@phosphor-icons/react'
import logoDark from '../../assets/crewcode-dark-version-logo.png'
import logoLight from '../../assets/crewcode-light-version-logo.png'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import { useIsDark } from '../../hooks/useIsDark'
import type { AgentInfo } from '../../types'
import type { AgentId } from '../../hooks/useSettings'

interface OnboardingProps {
  agents: AgentInfo[]
  defaultAgent: AgentId
  onSetDefaultAgent: (id: AgentId) => void
  hasProjects: boolean
  /** Opens the existing Add Project modal. */
  onAddProject: () => void
  /** Marks onboarding complete and dismisses the overlay. */
  onFinish: () => void
}

type StepKind = 'welcome' | 'agents' | 'info' | 'project'

interface StepDef {
  kind: StepKind
  eyebrow: string
  /** Phosphor icon for the step badge; null on the welcome step, which shows the logo. */
  icon: Icon | null
  title: string
  body: string
}

// The flow is a real sequence, so the eyebrow numbers the tour (welcome is the
// unnumbered cover). Interactive steps (agents, project) carry their own UI.
const STEPS: StepDef[] = [
  { kind: 'welcome', eyebrow: 'Welcome', icon: null, title: 'Welcome to CrewCode', body: 'An Agentic Coding Environment. Run a crew of AI coding agents in parallel across your projects — each in its own workspace with chat, terminals, an editor & more!.' },
  { kind: 'agents', eyebrow: '01 · Agents', icon: RobotIcon, title: 'Pick your default agent', body: 'CrewCode detected the coding agents installed on your machine. Choose the one new chats start with — you can switch per chat anytime.' },
  { kind: 'info', eyebrow: '02 · Chat', icon: ChatsCircleIcon, title: 'Message Threads', body: 'Each chat tab is a focused conversation with a single agent. Keep several sessions side by side or single and switch freely.' },
  { kind: 'info', eyebrow: '03 · Crew Code orchestration', icon: UsersThreeIcon, title: 'Launch a Crew of agents in parallel', body: 'Configure lanes with different roles, agents, models, and effort levels.' },
  { kind: 'info', eyebrow: '04 · Workspaces', icon: GitForkIcon, title: 'Isolated git worktrees', body: 'A workspace is a project on its own git worktree, so agents work in parallel without stepping on each other. Open the workspaces drawer to add, switch, and organize them.' },
  { kind: 'info', eyebrow: '05 · Git sidebar', icon: GitBranchIcon, title: 'Review every change', body: 'See exactly what an agent touched from the built-in git sidebar — staged and unstaged diffs, commits, and branch state, without leaving the app.' },
  { kind: 'info', eyebrow: '06 · Layout Panel', icon: SlidersHorizontalIcon, title: 'Shape your workspace', body: 'Open the floating Layout panel to change layout density and move or resize the workspaces dock.' },
  { kind: 'project', eyebrow: '07 · Your project', icon: FolderPlusIcon, title: 'Add your first project', body: 'Point CrewCode at a local folder, clone a repo, or start from scratch. You can always add more later.' },
]

export function Onboarding({ agents, defaultAgent, onSetDefaultAgent, hasProjects, onAddProject, onFinish }: OnboardingProps) {
  const [step, setStep] = useState(0)
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1
  const atStart = step === 0
  const isDark = useIsDark()
  const emblem = isDark ? logoDark : logoLight
  const StepIcon = current.icon
  const progress = ((step + 1) / STEPS.length) * 100

  const next = (): void => { if (isLast) onFinish(); else setStep(s => s + 1) }
  const back = (): void => setStep(s => Math.max(0, s - 1))

  // Keyboard nav matches the modal feel: Esc skips, Enter advances.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onFinish() }
      else if (e.key === 'Enter') { e.preventDefault(); next() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [step, isLast])

  return (
    <div className="ob-backdrop">
      <div className="ob" role="dialog" aria-label="Welcome to CrewCode" aria-modal="true">
        <div className="ob-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
        <img className="ob-watermark" src={emblem} alt="" aria-hidden="true" />

        <div className="ob-body">
          {/* Re-keyed per step so content animates in on each transition. */}
          <div className="ob-stage" key={step}>
            <div className="ob-eyebrow">{current.eyebrow}</div>

            {current.kind === 'welcome' ? (
              <div className="ob-logo-wrap">
                <img className="ob-logo" src={emblem} alt="CrewCode" />
              </div>
            ) : (
              <div className="ob-badge">{StepIcon && <StepIcon size={24} strokeWidth={1.75} />}</div>
            )}

            <h1 className="ob-title">{current.title}</h1>
            <p className="ob-text">{current.body}</p>

            {current.kind === 'agents' && (
              <div className="ob-agents">
                {agents.map(a => {
                  const img = PROVIDER_IMAGES[a.id]
                  const selectable = a.available
                  const selected = defaultAgent === a.id
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={`ob-agent ${selected ? 'on' : ''}`}
                      disabled={!selectable}
                      onClick={() => onSetDefaultAgent(a.id as AgentId)}
                    >
                      <span className="ob-agent-ico">
                        {img
                          ? <img src={img} alt="" width={18} height={18} className={providerImageClass(a.id)} />
                          : <RobotIcon size={15} />}
                      </span>
                      <span className="ob-agent-text">
                        <span className="ob-agent-name">{a.name}</span>
                        <span className="ob-agent-meta">{a.available ? (a.requiresApiKey && !a.hasKey ? 'needs API key' : 'detected') : `not installed${a.cmd ? ` · ${a.cmd}` : ''}`}</span>
                      </span>
                      {selected && <CheckFatIcon size={15} className="ob-agent-check" />}
                    </button>
                  )
                })}
                {agents.length === 0 && <div className="ob-empty">No agents detected. You can configure agent paths later in Settings.</div>}
                {agents.some(a => !a.available) && (
                  <div className="ob-hint">Missing one? Install its CLI, then set its path in Settings → Agents.</div>
                )}
              </div>
            )}

            {current.kind === 'project' && (
              <div className="ob-actions-inline">
                {hasProjects && <div className="ob-hint">You already have a project open — you’re all set.</div>}
                <button type="button" className="ap-btn primary" onClick={() => { onFinish(); onAddProject() }}>
                  <FolderPlusIcon size={15} /> Add a project
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="ob-foot">
          <span className="ob-count">{String(step + 1).padStart(2, '0')} / {String(STEPS.length).padStart(2, '0')}</span>
          <div className="ob-foot-btns">
            {!atStart && <button type="button" className="ap-btn ghost" onClick={back}><ArrowLeftIcon size={14} /> Back</button>}
            {!isLast && <button type="button" className="ap-btn ghost" onClick={onFinish}>Skip</button>}
            <button type="button" className="ap-btn primary" onClick={next}>
              {isLast ? <><RocketLaunchIcon size={15} /> Get started</> : <>Next <ArrowRightIcon size={15} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
