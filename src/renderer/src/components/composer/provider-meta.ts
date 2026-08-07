import claudeSvg from '../../assets/claude-color.svg'
import openaiSvg from '../../assets/openai.svg'
import opencodeSvg from '../../assets/opencode.svg'
import openrouterSvg from '../../assets/openrouter.svg'
import piSvg from '../../assets/pi.svg'
import hermesPng from '../../assets/hermes.png'
import ollamaSvg from '../../assets/ollama.svg'
import crewCoderPng from '../../assets/icon-logo-light.png'
import grokSvg from '../../assets/grok.svg'
import type { IconName } from '../ui/Icon'

export const PROVIDER_META: Record<string, { name: string; icon: IconName }> = {
  pi:        { name: 'Pi',        icon: 'bot' },
  opencode:  { name: 'OpenCode',  icon: 'terminal' },
  'opencode-go': { name: 'OpenCode Go', icon: 'terminal' },
  'openai-codex': { name: 'OpenAI Codex', icon: 'sparkle' },
  codex:     { name: 'Codex',     icon: 'sparkle' },
  claude:    { name: 'Claude',    icon: 'brain' },
  anthropic: { name: 'Anthropic', icon: 'brain' },
  openai:    { name: 'OpenAI',    icon: 'sparkle' },
  google:    { name: 'Google',    icon: 'globe' },
  hermes:    { name: 'Hermes',    icon: 'globe' },
  crewcoder: { name: 'CrewCoder', icon: 'bot' },
  grok:      { name: 'Grok Build', icon: 'sparkle' },
  ollama:    { name: 'Ollama',    icon: 'bot' },
  openrouter: { name: 'OpenRouter', icon: 'globe' },
}

export const PROVIDER_IMAGES: Record<string, string> = {
  claude:    claudeSvg,
  anthropic: claudeSvg,
  openai:    openaiSvg,
  'openai-codex': openaiSvg,
  codex:     openaiSvg,
  opencode:  opencodeSvg,
  'opencode-go': opencodeSvg,
  openrouter: openrouterSvg,
  pi:        piSvg,
  hermes:    hermesPng,
  crewcoder: crewCoderPng,
  grok:      grokSvg,
  ollama:    ollamaSvg,
}

// The Grok mark is a `currentColor` glyph, so it belongs with the monochrome
// set: the theme filter recolors it for dark/light instead of shipping two files.
const MONOCHROME_PROVIDER_IMAGES = new Set(['codex', 'openai', 'openai-codex', 'opencode', 'opencode-go', 'openrouter', 'pi', 'hermes', 'crewcoder', 'grok', 'ollama'])

export function providerImageClass(provider: string): string {
  return MONOCHROME_PROVIDER_IMAGES.has(provider)
    ? 'provider-logo provider-logo-monochrome'
    : 'provider-logo'
}
