/**
 * usePromptLibrary — persists prompts and skills to localStorage, plus the
 * set of skills the user has currently applied to active sessions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Prompt, Skill, CustomCategoryDef } from '../types/prompts'
import { SEED_PROMPTS, SEED_SKILLS } from '../components/promptBuilder/promptSeeds'

const STORAGE_PROMPTS = 'crewcode:prompts'
const STORAGE_SKILLS  = 'crewcode:skills'
const STORAGE_CUSTOM_CATEGORIES = 'crewcode:custom-categories'
const STORAGE_SKILLS_DEFAULT_MIGRATION = 'crewcode:skills:default-disabled:v1'

function loadList<T>(key: string, seed: T[]): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return seed
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as T[]
    return seed
  } catch {
    return seed
  }
}

function persist<T>(key: string, list: T[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)) } catch { /* quota */ }
}

function loadSkills(): Skill[] {
  const skills = loadList<Skill>(STORAGE_SKILLS, SEED_SKILLS)
  try {
    if (localStorage.getItem(STORAGE_SKILLS_DEFAULT_MIGRATION)) return skills
    localStorage.setItem(STORAGE_SKILLS_DEFAULT_MIGRATION, '1')
    // Older builds shipped this seed enabled, causing surprise auto-injection.
    return skills.map(s => s.id === 's-senior-eng' ? { ...s, enabled: false } : s)
  } catch {
    return skills.map(s => s.id === 's-senior-eng' ? { ...s, enabled: false } : s)
  }
}

export interface PromptLibrary {
  prompts:  Prompt[]
  skills:   Skill[]
  customCategories: CustomCategoryDef[]
  upsertPrompt: (p: Prompt) => void
  upsertSkill:  (s: Skill) => void
  deletePrompt: (id: string) => void
  deleteSkill:  (id: string) => void
  newPrompt:    () => Prompt
  newSkill:     () => Skill
  duplicate:    (kind: 'prompts' | 'skills', id: string) => string | null
  incUsage:     (kind: 'prompts' | 'skills', id: string) => void
  toggleSkillEnabled: (id: string) => void
  addCustomCategory:    (def: CustomCategoryDef) => void
  removeCustomCategory: (id: string) => void
}

const TIMESTAMP = (): string => new Date().toISOString()

function mergeLocalFiles<T extends { id: string }>(stored: T[], fromFiles: T[]): T[] {
  const fileIds = new Set(fromFiles.map(item => item.id))
  return [...fromFiles, ...stored.filter(item => !fileIds.has(item.id))]
}

export function usePromptLibrary(filePrompts: Prompt[] = [], fileSkills: Skill[] = []): PromptLibrary {
  const [storedPrompts, setPrompts] = useState<Prompt[]>(() => loadList<Prompt>(STORAGE_PROMPTS, SEED_PROMPTS))
  const [storedSkills,  setSkills]  = useState<Skill[]>(loadSkills)
  const [customCategories, setCustomCategories] = useState<CustomCategoryDef[]>(() => loadList<CustomCategoryDef>(STORAGE_CUSTOM_CATEGORIES, []))
  const [fileSkillEnabled, setFileSkillEnabled] = useState<Record<string, boolean>>({})
  const prompts = useMemo(() => mergeLocalFiles(storedPrompts, filePrompts), [storedPrompts, filePrompts])
  const fileSkillsWithState = useMemo(() => fileSkills.map(skill => (
    skill.id in fileSkillEnabled ? { ...skill, enabled: fileSkillEnabled[skill.id] } : skill
  )), [fileSkills, fileSkillEnabled])
  const skills  = useMemo(() => mergeLocalFiles(storedSkills,  fileSkillsWithState),  [storedSkills, fileSkillsWithState])

  useEffect(() => { persist(STORAGE_PROMPTS, storedPrompts) }, [storedPrompts])
  useEffect(() => { persist(STORAGE_SKILLS,  storedSkills)  }, [storedSkills])
  useEffect(() => { persist(STORAGE_CUSTOM_CATEGORIES, customCategories) }, [customCategories])

  const upsertPrompt = useCallback((p: Prompt) => {
    setPrompts(list => {
      const idx = list.findIndex(x => x.id === p.id)
      const next = { ...p, updatedAt: TIMESTAMP() }
      if (idx === -1) return [next, ...list]
      const copy = list.slice()
      copy[idx] = next
      return copy
    })
  }, [])

  const upsertSkill = useCallback((s: Skill) => {
    setSkills(list => {
      const idx = list.findIndex(x => x.id === s.id)
      const next = { ...s, updatedAt: TIMESTAMP() }
      if (idx === -1) return [next, ...list]
      const copy = list.slice()
      copy[idx] = next
      return copy
    })
  }, [])

  const deletePrompt = useCallback((id: string) => {
    setPrompts(list => list.filter(p => p.id !== id))
  }, [])

  const deleteSkill = useCallback((id: string) => {
    setSkills(list => list.filter(s => s.id !== id))
  }, [])

  const newPrompt = useCallback((): Prompt => ({
    id: `p-new-${Date.now()}`,
    title: 'untitled prompt',
    description: 'add a one-line description',
    category: 'code',
    favorite: false, used: 0, lastUsed: 'never',
    createdAt: TIMESTAMP(), updatedAt: TIMESTAMP(),
    body: '# untitled prompt\n\nwrite the prompt body here.\n\nuse `{{variable}}` for fields the user fills in at insert-time.',
  }), [])

  const newSkill = useCallback((): Skill => ({
    id: `s-new-${Date.now()}`,
    title: 'untitled skill',
    description: 'describe the behaviour this skill enforces',
    category: 'code',
    favorite: false, used: 0, lastUsed: 'never', enabled: false,
    createdAt: TIMESTAMP(), updatedAt: TIMESTAMP(),
    body: '# untitled skill\n\ndescribe how the agent should behave when this skill is enabled.\n\n## rules\n- be terse.\n- be specific.\n- ask before scaffolding.',
  }), [])

  const duplicate = useCallback((kind: 'prompts' | 'skills', id: string): string | null => {
    if (kind === 'prompts') {
      const src = prompts.find(p => p.id === id)
      if (!src) return null
      const dup: Prompt = { ...src, id: `p-dup-${Date.now()}`, title: `${src.title} (copy)`, used: 0, lastUsed: 'never', favorite: false, createdAt: TIMESTAMP(), updatedAt: TIMESTAMP() }
      setPrompts(list => [dup, ...list])
      return dup.id
    } else {
      const src = skills.find(s => s.id === id)
      if (!src) return null
      const dup: Skill = { ...src, id: `s-dup-${Date.now()}`, title: `${src.title} (copy)`, used: 0, lastUsed: 'never', favorite: false, enabled: false, createdAt: TIMESTAMP(), updatedAt: TIMESTAMP() }
      setSkills(list => [dup, ...list])
      return dup.id
    }
  }, [prompts, skills])

  const incUsage = useCallback((kind: 'prompts' | 'skills', id: string) => {
    const now = 'just now'
    if (kind === 'prompts') {
      setPrompts(list => list.map(p => p.id === id ? { ...p, used: p.used + 1, lastUsed: now, updatedAt: TIMESTAMP() } : p))
    } else {
      setSkills(list => list.map(s => s.id === id ? { ...s, used: s.used + 1, lastUsed: now, updatedAt: TIMESTAMP() } : s))
    }
  }, [])

  const toggleSkillEnabled = useCallback((id: string) => {
    const fileSkill = fileSkillsWithState.find(s => s.id === id)
    if (fileSkill) {
      setFileSkillEnabled(prev => ({ ...prev, [id]: !fileSkill.enabled }))
      return
    }
    setSkills(list => list.map(s => s.id === id ? { ...s, enabled: !s.enabled, updatedAt: TIMESTAMP() } : s))
  }, [fileSkillsWithState])

  const addCustomCategory = useCallback((def: CustomCategoryDef) => {
    setCustomCategories(list => {
      const idx = list.findIndex(c => c.id === def.id)
      if (idx === -1) return [...list, def]
      const copy = list.slice()
      copy[idx] = def
      return copy
    })
  }, [])

  const removeCustomCategory = useCallback((id: string) => {
    setCustomCategories(list => list.filter(c => c.id !== id))
  }, [])

  return {
    prompts, skills, customCategories,
    upsertPrompt, upsertSkill, deletePrompt, deleteSkill,
    newPrompt, newSkill, duplicate, incUsage, toggleSkillEnabled,
    addCustomCategory, removeCustomCategory,
  }
}
