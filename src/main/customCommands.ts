import { ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

/**
 * ~/.crewcode/commands holds slash-command definitions: one Markdown file per
 * command, shared across every provider. The filename (sans extension) is the
 * trigger and the file body is inserted into the composer. The settings screen
 * exposes an "open commands" button that routes here so the directory is created
 * lazily and the platform-correct file manager (Finder / Explorer / xdg-open)
 * takes it from there.
 */

function crewcodeDir(): string {
  return join(os.homedir(), '.crewcode')
}

function commandsDir(): string {
  return join(crewcodeDir(), 'commands')
}

function ensureCrewcodeDir(): string {
  const dir = crewcodeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  for (const child of ['commands', 'prompts', 'skills', 'plugins']) {
    const childDir = join(dir, child)
    if (!existsSync(childDir)) mkdirSync(childDir, { recursive: true })
  }
  return dir
}

function ensureDir(): string {
  ensureCrewcodeDir()
  const dir = commandsDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    // Seed a README so the directory isn't empty on first reveal.
    const readme = join(dir, 'README.md')
    if (!existsSync(readme)) {
      writeFileSync(
        readme,
        [
          '# CrewCode custom commands',
          '',
          'Drop one Markdown file per command here. The filename (sans .md) is the',
          'trigger; the file body is inserted into the composer. Commands are shared',
          'across every provider, so `/doc-updater` works for any agent.',
          '',
          'Examples:',
          '  doc-updater.md   ->  /doc-updater',
          '  review.md        ->  /review',
          '',
          'Optional frontmatter overrides the name and popover description:',
          '```markdown',
          '---',
          'name: review',
          'description: Review the current diff',
          '---',
          'Review the staged changes and flag risks.',
          '```',
          '',
        ].join('\n'),
      )
    }
  }
  return dir
}

export function registerCustomCommandsIpc(): void {
  ipcMain.handle('crewcode:configDir', () => {
    const dir = ensureCrewcodeDir()
    return { ok: true, path: dir }
  })

  ipcMain.handle('commands:openDir', () => {
    const dir = ensureDir()
    // Revealing a seeded file is more reliable than openPath(dir) on Linux,
    // where directory MIME associations can be hijacked by terminal apps.
    shell.showItemInFolder(join(dir, 'README.md'))
    return { ok: true, path: dir }
  })
}
