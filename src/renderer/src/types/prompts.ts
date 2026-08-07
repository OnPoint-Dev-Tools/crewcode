// Shared types and helpers for the Prompt Builder (prompts + skills).

/** Any string is now valid — built-in categories are preserved for UI seeding. */
export type PromptCategory = string

export interface PromptBase {
  id:          string
  title:       string
  description: string
  category:    PromptCategory
  favorite:    boolean
  used:        number
  lastUsed:    string
  body:        string
  createdAt:   string
  updatedAt:   string
}

export type Prompt = PromptBase

export interface Skill extends PromptBase {
  enabled: boolean
}

// A custom slash-command from ~/.crewcode/commands/<name>.md. One Markdown file
// per command, shared across every provider: the filename (sans extension) is
// the trigger and `body` is what gets inserted into the composer when picked.
export interface CustomCommand {
  id:          string   // local:command:<sourceRel>
  name:        string   // the slash word, e.g. "doc-updater" (from the filename)
  description: string   // shown in the popover (frontmatter or first body line)
  body:        string   // text inserted into the composer
}

export interface CategoryDef {
  id:    string
  label: string
}

export interface CustomCategoryDef extends CategoryDef {
  color: string
}

export const BUILTIN_CATEGORIES: CategoryDef[] = [
  { id: 'all',      label: 'All' },
  { id: 'code',     label: 'Code' },
  { id: 'review',   label: 'Review' },
  { id: 'debug',    label: 'Debug' },
  { id: 'refactor', label: 'Refactor' },
  { id: 'docs',     label: 'Docs' },
]

export const BUILTIN_CATEGORY_COLORS: Record<string, string> = {
  code:     '#7dd3a8',
  review:   '#fcd452',
  debug:    '#f87171',
  refactor: '#c084fc',
  docs:     '#60a5fa',
}

/** Palette for auto-generated custom category colors. */
const CUSTOM_PALETTE = [
  '#f472b6', '#fb923c', '#a3e635', '#22d3ee', '#a78bfa',
  '#f87171', '#34d399', '#60a5fa', '#fbbf24', '#c084fc',
  '#2dd4bf', '#f87171', '#818cf8', '#e879f9', '#38bdf8',
]

function hashString(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Resolve a color for any category id — built-ins get their canonical color,
 *  unknowns get a deterministic palette color. */
export function getCategoryColor(categoryId: string): string {
  return BUILTIN_CATEGORY_COLORS[categoryId] ?? CUSTOM_PALETTE[hashString(categoryId) % CUSTOM_PALETTE.length]
}

/** Build the full category list for UI filtering (built-in + custom + all). */
export function getAllCategories(customCategories: CustomCategoryDef[] = []): CategoryDef[] {
  const seen = new Set<string>(['all', ...BUILTIN_CATEGORIES.map(c => c.id)])
  const extras = customCategories.filter(c => !seen.has(c.id))
  return [...BUILTIN_CATEGORIES, ...extras]
}

/** Resolve a human label for any category id. */
export function getCategoryLabel(categoryId: string, customCategories: CustomCategoryDef[] = []): string {
  if (categoryId === 'all') return 'All'
  const builtin = BUILTIN_CATEGORIES.find(c => c.id === categoryId)
  if (builtin) return builtin.label
  const custom = customCategories.find(c => c.id === categoryId)
  return custom?.label ?? categoryId
}

// Back-compat: keep the old names as exports so imports that only use built-ins
// still work, but they now point to the new helpers.
export const CATEGORIES = BUILTIN_CATEGORIES
export const CATEGORY_COLORS = BUILTIN_CATEGORY_COLORS

const VAR_PATTERN = '\\{\\{\\s*([a-zA-Z0-9_-]+)\\s*\\}\\}'

export function extractVars(body: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(VAR_PATTERN, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]) }
  }
  return out
}

export function fillVars(body: string, vars: Record<string, string>): string {
  return body.replace(new RegExp(VAR_PATTERN, 'g'),
    (_match: string, k: string) => vars[k] && vars[k].length > 0 ? vars[k] : `{{${k}}}`)
}
