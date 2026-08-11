import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export type CrewCheckId = 'typecheck' | 'test'

export interface SuggestedCrewCheck {
  id: CrewCheckId
  label: string
  command: string
  args: string[]
  script: string
}

function packageManager(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  return 'npm'
}

/** Build the allowlisted check list from package metadata already read locally or over SSH. */
export function suggestedCrewChecksForScripts(
  scripts: Record<string, unknown>,
  manager: string,
): SuggestedCrewCheck[] {
  const checks: SuggestedCrewCheck[] = []
  for (const id of ['typecheck', 'test'] as const) {
    const script = scripts[id]
    if (typeof script !== 'string' || !script.trim()) continue
    checks.push({
      id,
      label: id === 'typecheck' ? 'Typecheck' : 'Tests',
      command: manager,
      args: ['run', id],
      script,
    })
  }
  return checks
}

/**
 * Discover a deliberately small allowlist of verification scripts. The renderer
 * can request only these ids; it cannot turn this IPC route into arbitrary shell
 * execution. Script bodies are returned so the human can review what a click runs.
 */
export function suggestedCrewChecks(cwd: string): SuggestedCrewCheck[] {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    return suggestedCrewChecksForScripts(pkg.scripts ?? {}, packageManager(cwd))
  } catch {
    return []
  }
}

export function resolveSuggestedCrewCheck(cwd: string, id: string): SuggestedCrewCheck | null {
  return suggestedCrewChecks(cwd).find(check => check.id === id) ?? null
}
