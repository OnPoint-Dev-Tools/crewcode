import type {
  BrowserGrabSelectionPayload,
  BrowserGrabScreenshotPayload,
} from '../../../../shared/browser-grab-types'

export function formatBrowserGrab(selection: BrowserGrabSelectionPayload): string {
  const lines = [
    `Page: ${selection.page.url}`,
    `Title: ${selection.page.title || '(untitled)'}`,
    '',
    'Selected element:',
    selection.target.selector || selection.target.tagName,
    '',
  ]

  if (selection.target.textSnippet) {
    lines.push('Text:', selection.target.textSnippet, '')
  }

  lines.push('HTML:', selection.target.htmlSnippet, '')

  if (selection.nearbyText.length) {
    lines.push('Nearby text:')
    for (const item of selection.nearbyText) lines.push(`- ${item}`)
    lines.push('')
  }

  if (selection.ancestorPath.length) {
    lines.push('Ancestor path:', selection.ancestorPath.join(' > '), '')
  }

  return lines.join('\n').trim()
}

export async function copyBrowserGrabToClipboard(selection: BrowserGrabSelectionPayload): Promise<string> {
  const text = formatBrowserGrab(selection)
  const result = await window.electronAPI?.clipboardWriteText(text)
  if (!result?.ok) throw new Error(result?.error || 'text clipboard write failed')
  return text
}

export function formatBrowserGrabForChat(selection: BrowserGrabSelectionPayload, comment: string): string {
  const note = comment.trim()
  const lines = [
    note ? `User note:\n${note}\n` : '',
    'Please use this grabbed browser context:',
    '',
    formatBrowserGrab(selection),
  ].filter(Boolean)

  return lines.join('\n')
}

export async function copyBrowserScreenshotPathToClipboard(
  screenshot: BrowserGrabScreenshotPayload,
): Promise<string> {
  const pathText = screenshot.filePath
  const result = await window.electronAPI?.clipboardWriteText(pathText)
  if (!result?.ok) throw new Error(result?.error || 'screenshot path clipboard write failed')
  return pathText
}
