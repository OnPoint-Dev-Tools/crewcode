export const FRESH_CHAT_BACKGROUND_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const FRESH_CHAT_BACKGROUND_ACCEPT = FRESH_CHAT_BACKGROUND_TYPES.join(',')
export const FRESH_CHAT_BACKGROUND_MAX_BYTES = 2 * 1024 * 1024

export interface ChatBackgroundPalette {
  mode: 'dark' | 'light'
  hue: number
  saturation: number
  primary: string
  primaryBright: string
  background: string
  card: string
  popover: string
  muted: string
  accent: string
  border: string
  foreground: string
  mutedForeground: string
  primaryForeground: string
  bubbleBackground: string
  bubbleForeground: string
}

const ALLOWED_TYPE_SET = new Set<string>(FRESH_CHAT_BACKGROUND_TYPES)
const MAX_DATA_URL_LENGTH = Math.ceil(FRESH_CHAT_BACKGROUND_MAX_BYTES * 4 / 3) + 128
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i

export function freshChatBackgroundError(file: Pick<File, 'type' | 'size'>): string | null {
  if (!ALLOWED_TYPE_SET.has(file.type)) return 'Choose a png, jpg, webp, or gif image.'
  if (file.size > FRESH_CHAT_BACKGROUND_MAX_BYTES) return 'Choose an image under 2 MB so local settings stay fast.'
  return null
}

export function normalizeFreshChatBackground(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DATA_URL_LENGTH || !RASTER_DATA_URL.test(value)) return ''
  return value
}

export function shouldShowChatBackground(input: {
  threadView: string
  hasBackground: boolean
  messageCount: number
  showInRegularChats: boolean
}): boolean {
  return input.threadView === 'chat'
    && input.hasBackground
    && (input.messageCount === 0 || input.showInRegularChats)
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue = max === rn
    ? (gn - bn) / delta + (gn < bn ? 6 : 0)
    : max === gn
      ? (bn - rn) / delta + 2
      : (rn - gn) / delta + 4
  hue *= 60
  return [hue, saturation, lightness]
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${Math.round(hue)} ${Math.round(saturation)}% ${Math.round(lightness)}%)`
}

export function deriveChatBackgroundPalette(pixels: Uint8ClampedArray): ChatBackgroundPalette {
  let luminanceTotal = 0
  let pixelCount = 0
  const buckets = new Map<string, { count: number; r: number; g: number; b: number; score: number }>()
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]
    if (alpha < 128) continue
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    const [, saturation, lightness] = rgbToHsl(r, g, b)
    luminanceTotal += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    pixelCount += 1
    // Quantization favors a representative color family over a one-pixel highlight.
    const key = `${r >> 5}:${g >> 5}:${b >> 5}`
    const current = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, score: 0 }
    current.count += 1
    current.r += r
    current.g += g
    current.b += b
    current.score += 0.05 + saturation * 1.25 + (1 - Math.abs(lightness - 0.5)) * 0.15
    buckets.set(key, current)
  }

  const fallback = { count: 1, r: 40, g: 90, b: 72, score: 1 }
  const selected = [...buckets.values()].sort((a, b) => b.score - a.score)[0] ?? fallback
  const [rawHue, rawSaturation] = rgbToHsl(
    selected.r / selected.count,
    selected.g / selected.count,
    selected.b / selected.count,
  )
  const hue = Math.round(rawHue)
  const saturation = Math.round(rawSaturation < 0.08 ? 10 : Math.max(28, Math.min(72, rawSaturation * 100)))
  const mode = pixelCount > 0 && luminanceTotal / pixelCount > 0.68 ? 'light' : 'dark'

  if (mode === 'light') {
    return {
      mode, hue, saturation,
      primary: hsl(hue, saturation, 34),
      primaryBright: hsl(hue, Math.min(82, saturation + 12), 45),
      background: hsl(hue, Math.min(18, saturation / 3), 96),
      card: hsl(hue, Math.min(16, saturation / 3), 99),
      popover: hsl(hue, Math.min(16, saturation / 3), 99),
      muted: hsl(hue, Math.min(22, saturation / 2), 91),
      accent: hsl(hue, Math.min(30, saturation / 2), 88),
      border: hsl(hue, Math.min(34, saturation / 2), 76),
      foreground: hsl(hue, 12, 13),
      mutedForeground: hsl(hue, 10, 40),
      primaryForeground: '#ffffff',
      bubbleBackground: hsl(hue, Math.min(38, saturation), 89),
      bubbleForeground: hsl(hue, 24, 18),
    }
  }

  return {
    mode, hue, saturation,
    primary: hsl(hue, saturation, 38),
    primaryBright: hsl(hue, Math.min(84, saturation + 12), 60),
    background: hsl(hue, Math.min(20, saturation / 3), 7),
    card: hsl(hue, Math.min(24, saturation / 2), 12),
    popover: hsl(hue, Math.min(22, saturation / 2), 9),
    muted: hsl(hue, Math.min(25, saturation / 2), 17),
    accent: hsl(hue, Math.min(38, saturation), 19),
    border: hsl(hue, Math.min(40, saturation), 27),
    foreground: hsl(hue, 14, 96),
    mutedForeground: hsl(hue, 10, 67),
    primaryForeground: '#ffffff',
    bubbleBackground: hsl(hue, Math.min(42, saturation), 17),
    bubbleForeground: hsl(hue, 28, 90),
  }
}

export async function extractChatBackgroundPalette(dataUrl: string): Promise<ChatBackgroundPalette> {
  const image = new Image()
  image.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Could not decode that image.'))
    image.src = dataUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = 48
  canvas.height = 48
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Image color analysis is unavailable.')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return deriveChatBackgroundPalette(context.getImageData(0, 0, canvas.width, canvas.height).data)
}

export function normalizeChatBackgroundPalette(value: unknown): ChatBackgroundPalette | null {
  if (!value || typeof value !== 'object') return null
  const palette = value as Partial<ChatBackgroundPalette>
  const colorKeys: Array<keyof ChatBackgroundPalette> = [
    'primary', 'primaryBright', 'background', 'card', 'popover', 'muted', 'accent', 'border',
    'foreground', 'mutedForeground', 'primaryForeground', 'bubbleBackground', 'bubbleForeground',
  ]
  if (palette.mode !== 'dark' && palette.mode !== 'light') return null
  if (!Number.isFinite(palette.hue) || !Number.isFinite(palette.saturation)) return null
  if (colorKeys.some(key => typeof palette[key] !== 'string' || !/^#[0-9a-f]{6}$|^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/i.test(palette[key] as string))) return null
  return palette as ChatBackgroundPalette
}
