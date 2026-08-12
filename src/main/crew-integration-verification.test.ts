import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { suggestedCrewChecks } from './crew-verification'
import { applyCrewIntegration, verifyCrewIntegration, type IntegrationGitRunner } from './crew-integration-verification'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const write = (cwd: string, path: string, value: string): void => writeFileSync(join(cwd, path), value)

function fixture(): { repo: string; baseHead: string; migrationHead: string; apiHead: string } {
  const repo = mkdtempSync(join(tmpdir(), 'crew-integration-'))
  roots.push(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, 'package.json', JSON.stringify({ scripts: { test: 'node verify.cjs' } }))
  write(repo, 'verify.cjs', `const fs=require('fs');const a=fs.readFileSync('migration.sql','utf8');const b=fs.readFileSync('model.ts','utf8');if(a.includes('user_id')&&b.includes('accountId')){console.error('migration/model contract mismatch');process.exit(1)}`)
  write(repo, 'migration.sql', 'CREATE TABLE users (id INTEGER);\n')
  write(repo, 'model.ts', 'export const primaryKey = "id"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')
  const baseHead = git(repo, 'rev-parse', 'HEAD')

  git(repo, 'switch', '-c', 'lane/migration')
  write(repo, 'migration.sql', 'CREATE TABLE users (user_id INTEGER);\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'change migration')
  const migrationHead = git(repo, 'rev-parse', 'HEAD')

  git(repo, 'switch', 'main')
  git(repo, 'switch', '-c', 'lane/api')
  write(repo, 'model.ts', 'export const primaryKey = "accountId"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'change model api contract')
  const apiHead = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'switch', 'main')
  return { repo, baseHead, migrationHead, apiHead }
}

const runner: IntegrationGitRunner = async (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const runCheck = async (cwd: string, check: { command: string; args: string[] }) => {
  const result = spawnSync(check.command, check.args, {
    cwd, encoding: 'utf8', env: { ...process.env, CI: '1' },
    // npm/pnpm/yarn are .cmd shims on Windows and require cmd.exe.
    shell: process.platform === 'win32',
  })
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('crew combined integration verification', () => {
  it('catches a migration/model behavioral collision before either branch lands', async () => {
    const f = fixture()
    const integrationPath = join(f.repo, '.crew-integration')
    const result = await verifyCrewIntegration({
      repoPath: f.repo, integrationPath, integrationCwd: integrationPath,
      baseBranch: 'main', baseHead: f.baseHead,
      lanes: [
        { laneId: 'migration', label: 'Migration', branch: 'lane/migration', head: f.migrationHead, worktreePath: '/migration', files: ['migration.sql'] },
        { laneId: 'api', label: 'API', branch: 'lane/api', head: f.apiHead, worktreePath: '/api', files: ['model.ts'] },
      ],
      retentionRef: 'refs/crewcode/integration/test',
    }, runner, async cwd => suggestedCrewChecks(cwd), runCheck)

    expect(result.ok).toBe(false)
    expect(result.status).toBe('checks-failed')
    if (result.status === 'checks-failed') expect(result.checks[0].output).toContain('migration/model contract mismatch')
    expect(git(f.repo, 'rev-parse', 'main')).toBe(f.baseHead)
    expect(readFileSync(join(f.repo, 'migration.sql'), 'utf8')).toContain('(id INTEGER)')
    expect(existsSync(integrationPath)).toBe(false)
  })

  it('retains the exact passing candidate and applies it only when inputs remain unchanged', async () => {
    const f = fixture()
    // Make the API lane compatible with the migration lane.
    git(f.repo, 'switch', 'lane/api')
    write(f.repo, 'model.ts', 'export const primaryKey = "user_id"\n')
    git(f.repo, 'add', '.')
    git(f.repo, 'commit', '-m', 'use migrated key')
    const apiHead = git(f.repo, 'rev-parse', 'HEAD')
    git(f.repo, 'switch', 'main')
    const integrationPath = join(f.repo, '.crew-integration')
    const request = {
      repoPath: f.repo, integrationPath, integrationCwd: integrationPath,
      baseBranch: 'main', baseHead: f.baseHead,
      lanes: [
        { laneId: 'migration', label: 'Migration', branch: 'lane/migration', head: f.migrationHead, worktreePath: '/migration', files: ['migration.sql'] },
        { laneId: 'api', label: 'API', branch: 'lane/api', head: apiHead, worktreePath: '/api', files: ['model.ts'] },
      ],
      retentionRef: 'refs/crewcode/integration/test',
    }
    const verified = await verifyCrewIntegration(request, runner, async cwd => suggestedCrewChecks(cwd), runCheck)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(git(f.repo, 'rev-parse', request.retentionRef)).toBe(verified.integrationHead)
    expect(git(f.repo, 'rev-parse', 'main')).toBe(f.baseHead)

    const applied = await applyCrewIntegration({ ...request, integrationHead: verified.integrationHead }, runner)
    expect(applied).toEqual({ ok: true })
    expect(git(f.repo, 'rev-parse', 'main')).toBe(verified.integrationHead)
    const deletedRef = spawnSync('git', ['rev-parse', '--verify', request.retentionRef], { cwd: f.repo, encoding: 'utf8' })
    expect(deletedRef.status).not.toBe(0)
  })
})
