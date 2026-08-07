export interface PublishRepoOpts {
  name: string
  visibility: 'private' | 'public'
  description?: string
}

export interface CommandResult {
  ok: boolean
  output: string
  error?: string
}

export type PublishCommandRunner = (command: 'git' | 'gh', args: string[]) => CommandResult

function failure(result: CommandResult): CommandResult {
  return { ok: false, output: result.output, error: result.error || result.output || 'publish command failed' }
}

/** Publish a folder end-to-end, and safely resume after a partially completed attempt. */
export function publishRepository(opts: PublishRepoOpts, run: PublishCommandRunner): CommandResult {
  const name = opts.name.trim()
  if (!name) return { ok: false, output: '', error: 'repository name is required' }

  const output: string[] = []
  const exec = (command: 'git' | 'gh', args: string[]): CommandResult => {
    const result = run(command, args)
    if (result.output) output.push(result.output)
    return result
  }

  let result = exec('git', ['rev-parse', '--is-inside-work-tree'])
  if (!result.ok) {
    result = exec('git', ['init'])
    if (!result.ok) return failure({ ...result, output: output.join('\n') })
  }

  result = exec('git', ['add', '--all'])
  if (!result.ok) return failure({ ...result, output: output.join('\n') })

  const hasCommit = exec('git', ['rev-parse', '--verify', 'HEAD']).ok
  if (!hasCommit) {
    // An initial publish must not stall on a signing prompt unavailable to the
    // Electron main process. Users can sign subsequent commits normally.
    result = exec('git', ['commit', '--no-gpg-sign', '-m', 'Initial commit'])
    if (!result.ok) return failure({ ...result, output: output.join('\n') })
    result = exec('git', ['branch', '-M', 'main'])
    if (!result.ok) return failure({ ...result, output: output.join('\n') })
  }

  const origin = exec('git', ['remote', 'get-url', 'origin'])
  if (!origin.ok) {
    const createArgs = ['repo', 'create', name, `--${opts.visibility}`, '--source', '.', '--remote', 'origin']
    if (opts.description?.trim()) createArgs.push('--description', opts.description.trim())
    result = exec('gh', createArgs)
    if (!result.ok) return failure({ ...result, output: output.join('\n') })
  }

  const branch = exec('git', ['branch', '--show-current'])
  if (!branch.ok) return failure({ ...branch, output: output.join('\n') })
  const branchName = branch.output.trim() || 'main'
  result = exec('git', ['push', '-u', 'origin', branchName])
  if (!result.ok) return failure({ ...result, output: output.join('\n') })

  return { ok: true, output: output.join('\n') }
}
