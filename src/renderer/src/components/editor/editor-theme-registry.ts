import type { Extension } from '@codemirror/state'
import {
  amy,
  ayuLight,
  barf,
  bespin,
  birdsOfParadise,
  boysAndGirls,
  clouds,
  cobalt,
  coolGlow,
  dracula,
  espresso,
  noctisLilac,
  rosePineDawn,
  smoothy,
  solarizedLight,
  tomorrow,
} from '../../../../../packages/crew-codemirror/theme-library/index'
import type { EditorThemeId } from '../../../../shared/editor-theme-types'

export type EditorThemeOption = {
  id: EditorThemeId
  label: string
  variant: 'dark' | 'light' | 'app'
  extension: Extension
}

export const EDITOR_THEME_OPTIONS: readonly EditorThemeOption[] = [
  { id: 'crewcode', label: 'CrewCode', variant: 'app', extension: [] },
  { id: 'amy', label: 'Amy', variant: 'dark', extension: amy },
  { id: 'barf', label: 'Barf', variant: 'dark', extension: barf },
  { id: 'bespin', label: 'Bespin', variant: 'dark', extension: bespin },
  { id: 'birds-of-paradise', label: 'Birds of Paradise', variant: 'dark', extension: birdsOfParadise },
  { id: 'boys-and-girls', label: 'Boys and Girls', variant: 'dark', extension: boysAndGirls },
  { id: 'cobalt', label: 'Cobalt', variant: 'dark', extension: cobalt },
  { id: 'cool-glow', label: 'Cool Glow', variant: 'dark', extension: coolGlow },
  { id: 'dracula', label: 'Dracula', variant: 'dark', extension: dracula },
  { id: 'ayu-light', label: 'Ayu Light', variant: 'light', extension: ayuLight },
  { id: 'clouds', label: 'Clouds', variant: 'light', extension: clouds },
  { id: 'noctis-lilac', label: 'Noctis Lilac', variant: 'light', extension: noctisLilac },
  { id: 'espresso', label: 'Espresso', variant: 'light', extension: espresso },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', variant: 'light', extension: rosePineDawn },
  { id: 'smoothy', label: 'Smoothy', variant: 'light', extension: smoothy },
  { id: 'solarized-light', label: 'Solarized Light', variant: 'light', extension: solarizedLight },
  { id: 'tomorrow', label: 'Tomorrow', variant: 'light', extension: tomorrow },
]

const extensions = new Map(EDITOR_THEME_OPTIONS.map(theme => [theme.id, theme.extension]))

export function editorThemeExtension(id: EditorThemeId): Extension {
  return extensions.get(id) ?? []
}
