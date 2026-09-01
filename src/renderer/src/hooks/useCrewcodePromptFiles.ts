import { useEffect, useState } from 'react'
import type { CustomCommand, Prompt, PromptCategory, Skill } from '../types/prompts'

// PromptCategory is now string; keep this list only for UI back-compat.
const BUILTIN_CATEGORIES: string[] = ['code', 'review', 'debug', 'refactor', 'docs']
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.prompt', '.skill'])
const JSON_EXTENSIONS = new Set(['.json'])
const EXTENSION_MATCH = /(\.[^./\\]+)$/

type LoadedCrewcodeLibrary = {
  prompts: Prompt[]
  skills: Skill[]
  commands: CustomCommand[]
  error: string | null
}

type PromptFileMeta = Partial<Pick<Prompt, 'title' | 'description' | 'category' | 'favorite' | 'body'>> & {
  id?: string
  enabled?: boolean
}

const EMPTY_LIBRARY: LoadedCrewcodeLibrary = { prompts: [], skills: [], commands: [], error: null }

/**
 * The library is owned by App, so replacing it makes the full renderer tree
 * reconcile. Polling must therefore publish only meaningful file changes, not
 * fresh arrays (and fresh generated timestamps) from an unchanged scan.
 */
export function promptLibraryContentKey(library: LoadedCrewcodeLibrary): string {
  return JSON.stringify({
    prompts: library.prompts.map(prompt => [
      prompt.id, prompt.title, prompt.description, prompt.category,
      prompt.favorite, prompt.body,
    ]),
    skills: library.skills.map(skill => [
      skill.id, skill.title, skill.description, skill.category,
      skill.favorite, skill.body, skill.enabled,
    ]),
    commands: library.commands.map(command => [
      command.id, command.name, command.description, command.body,
    ]),
    error: library.error,
  })
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asCategory(value: unknown): PromptCategory {
  const s = typeof value === 'string' && value.trim() ? value.trim() : ''
  return s || 'code'
}

function titleFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'untitled'
}

function fileKind(name: string): 'text' | 'json' | 'skip' {
  const ext = EXTENSION_MATCH.exec(name)?.[1]?.toLowerCase()
  if (!ext) return 'text'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (JSON_EXTENSIONS.has(ext)) return 'json'
  return 'skip'
}

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: text }
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return { meta: {}, body: text }
  const rawMeta = normalized.slice(4, end)
  const body = normalized.slice(end + 5).replace(/^\n/, '')
  const meta: Record<string, unknown> = {}
  for (const line of rawMeta.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const rawValue = match[2].trim()
    if (rawValue === 'true') meta[match[1]] = true
    else if (rawValue === 'false') meta[match[1]] = false
    else meta[match[1]] = rawValue.replace(/^['"]|['"]$/g, '')
  }
  return { meta, body }
}

function toPrompt(meta: PromptFileMeta, body: string, sourceRel: string, name: string): Prompt {
  const now = new Date().toISOString()
  return {
    id: `local:prompt:${meta.id ?? sourceRel}`,
    title: asString(meta.title, titleFromName(name)),
    description: asString(meta.description, 'local .crewcode prompt'),
    category: asCategory(meta.category),
    favorite: Boolean(meta.favorite),
    used: 0,
    lastUsed: 'never',
    body: asString(meta.body, body),
    createdAt: now,
    updatedAt: now,
  }
}

function toSkill(meta: PromptFileMeta, body: string, sourceRel: string, name: string): Skill {
  return {
    ...toPrompt(meta, body, sourceRel, name),
    id: `local:skill:${meta.id ?? sourceRel}`,
    description: asString(meta.description, 'local .crewcode skill'),
    enabled: Boolean(meta.enabled),
  }
}

function parseTextFile(text: string): { meta: PromptFileMeta; body: string } {
  const parsed = parseFrontmatter(text)
  return { meta: parsed.meta as PromptFileMeta, body: parsed.body }
}

async function readDirectoryFiles(root: string, subdir: string, depth = 0): Promise<Array<{ name: string; rel: string; kind: 'file' }>> {
  const api = window.electronAPI
  if (!api || depth > 4) return []
  const res = await api.fsReadDir(root, subdir)
  if (res.error || !res.nodes) return []
  const files: Array<{ name: string; rel: string; kind: 'file' }> = []
  for (const entry of res.nodes) {
    if (entry.kind === 'file') {
      files.push({ name: entry.name, rel: entry.rel, kind: 'file' })
    } else if (entry.kind === 'dir') {
      files.push(...await readDirectoryFiles(root, entry.rel, depth + 1))
    }
  }
  return files
}

async function loadPromptGroup<T extends Prompt | Skill>(
  root: string,
  subdir: 'prompts' | 'skills',
  makeItem: (meta: PromptFileMeta, body: string, sourceRel: string, name: string) => T,
): Promise<T[]> {
  const api = window.electronAPI
  if (!api) return []
  const files = await readDirectoryFiles(root, subdir)
  const loaded: T[] = []
  for (const file of files) {
    try {
      const kind = fileKind(file.name)
      if (kind === 'skip') continue
      const res = await api.fsReadFile(root, file.rel)
      if (res.error || typeof res.text !== 'string') continue
      if (kind === 'json') {
        const parsed = JSON.parse(res.text) as PromptFileMeta | PromptFileMeta[]
        const entries = Array.isArray(parsed) ? parsed : [parsed]
        for (const [idx, item] of entries.entries()) {
          loaded.push(makeItem(item, asString(item.body), `${file.rel}#${idx}`, file.name))
        }
        continue
      }
      const { meta, body } = parseTextFile(res.text)
      loaded.push(makeItem(meta, body, file.rel, file.name))
    } catch {
      // One malformed local file should not hide the rest of the Studio library.
    }
  }
  return loaded
}

// First meaningful line of a command body, used as the popover preview when no
// frontmatter `description` is set. Strips a leading Markdown heading marker.
function firstBodyLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line
  }
  return 'local command'
}

// ~/.crewcode/commands/<name>.md — one Markdown file per slash-command, shared
// across every provider. The filename (sans extension) is the trigger and the
// file body is inserted into the composer. README.md is the dir's help file, so
// it is skipped rather than offered as a `/readme` command.
async function loadCommandGroup(root: string): Promise<CustomCommand[]> {
  const api = window.electronAPI
  if (!api) return []
  const files = await readDirectoryFiles(root, 'commands')
  const loaded: CustomCommand[] = []
  for (const file of files) {
    if (fileKind(file.name) !== 'text') continue
    if (/^readme\.[^.]+$/i.test(file.name)) continue
    try {
      const res = await api.fsReadFile(root, file.rel)
      if (res.error || typeof res.text !== 'string') continue
      const { meta, body } = parseTextFile(res.text)
      const text = asString(meta.body, body)
      if (!text.trim()) continue
      const name = asString((meta as { name?: unknown }).name, titleFromName(file.name))
      const description = asString(meta.description) || firstBodyLine(text)
      loaded.push({ id: `local:command:${file.rel}`, name, description, body: text })
    } catch {
      // One malformed command file should not hide the rest.
    }
  }
  return loaded
}

export function useCrewcodePromptFiles(): LoadedCrewcodeLibrary {
  const [library, setLibrary] = useState<LoadedCrewcodeLibrary>(EMPTY_LIBRARY)

  useEffect(() => {
    const api = window.electronAPI
    if (!api) { setLibrary(EMPTY_LIBRARY); return }
    let cancelled = false
    let loading = false

    const publish = (next: LoadedCrewcodeLibrary): void => {
      if (cancelled) return
      const nextKey = promptLibraryContentKey(next)
      setLibrary(previous => promptLibraryContentKey(previous) === nextKey ? previous : next)
    }

    const load = async (): Promise<void> => {
      // A slow filesystem/SSH scan must not accumulate behind the poll timer.
      if (loading) return
      loading = true
      try {
        const config = await api.crewcodeConfigDir()
        if (!config.ok || !config.path) throw new Error(config.error ?? 'CrewCode config dir unavailable')
        const [prompts, skills, commands] = await Promise.all([
          loadPromptGroup(config.path, 'prompts', toPrompt),
          loadPromptGroup(config.path, 'skills', toSkill),
          loadCommandGroup(config.path),
        ])
        publish({ prompts, skills, commands, error: null })
      } catch (err) {
        publish({ prompts: [], skills: [], commands: [], error: (err as Error).message })
      } finally {
        loading = false
      }
    }

    void load()
    // Poll because users can add files outside CrewCode while Studio is open.
    const interval = window.setInterval(() => { void load() }, 5000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [])

  return library
}
