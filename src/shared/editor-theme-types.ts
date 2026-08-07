export const EDITOR_THEME_IDS = [
  'crewcode',
  'amy',
  'ayu-light',
  'barf',
  'bespin',
  'birds-of-paradise',
  'boys-and-girls',
  'clouds',
  'cobalt',
  'cool-glow',
  'dracula',
  'espresso',
  'noctis-lilac',
  'rose-pine-dawn',
  'smoothy',
  'solarized-light',
  'tomorrow',
] as const

export type EditorThemeId = (typeof EDITOR_THEME_IDS)[number]

export function isEditorThemeId(value: unknown): value is EditorThemeId {
  return typeof value === 'string' && (EDITOR_THEME_IDS as readonly string[]).includes(value)
}
