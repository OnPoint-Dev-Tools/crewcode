const BLOCKED_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META'])

/** LSP hover/completion Markdown comes from a workspace process and is untrusted HTML. */
export function sanitizeLspHTML(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT)
  const elements: Element[] = []
  while (walker.nextNode()) elements.push(walker.currentNode as Element)
  for (const element of elements) {
    if (BLOCKED_ELEMENTS.has(element.tagName)) {
      element.remove()
      continue
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'style' || name === 'src') {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === 'href') {
        try {
          const protocol = new URL(attribute.value, window.location.href).protocol
          if (!['http:', 'https:', 'mailto:'].includes(protocol)) element.removeAttribute(attribute.name)
        } catch {
          element.removeAttribute(attribute.name)
        }
      }
    }
    if (element.tagName === 'A' && element.hasAttribute('href')) {
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noreferrer')
    }
  }
  return template.innerHTML
}
