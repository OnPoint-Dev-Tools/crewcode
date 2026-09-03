export interface PullRequestBodySection {
  title: string
  body: string
  provided: boolean
}

const CANONICAL_SECTIONS = [
  { title: 'Description', aliases: ['description', 'summary', 'overview'] },
  { title: 'Problem', aliases: ['problem', 'issue', 'motivation'] },
  { title: 'What changed', aliases: ['what changed', 'changes', 'implementation'] },
  { title: 'Why it changed', aliases: ['why it changed', 'why', 'rationale'] },
  { title: 'Solution', aliases: ['solution', 'approach', 'resolution'] },
] as const

function normalizedHeading(value: string): string {
  return value.trim().toLowerCase().replace(/[?:]+$/, '').replace(/\s+/g, ' ')
}

/** Preserve author-written Markdown while making missing review context explicit. */
export function parsePullRequestBodySections(source: string): PullRequestBodySection[] {
  const text = source.trim()
  const authored: Array<{ title: string; body: string }> = []
  let title = 'Description'
  let lines: string[] = []
  const flush = () => {
    const body = lines.join('\n').trim()
    if (body) authored.push({ title, body })
    lines = []
  }
  for (const line of (text ? text.split(/\r?\n/) : [])) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/)
    if (!heading) { lines.push(line); continue }
    flush()
    title = heading[1].replace(/\s+#+$/, '').trim() || 'Description'
  }
  flush()

  const consumed = new Set<number>()
  const canonical = CANONICAL_SECTIONS.map(section => {
    const index = authored.findIndex((entry, entryIndex) => !consumed.has(entryIndex) && section.aliases.some(alias => alias === normalizedHeading(entry.title)))
    if (index < 0) return { title: section.title, body: '', provided: false }
    consumed.add(index)
    return { title: section.title, body: authored[index].body, provided: true }
  })
  const additional = authored.flatMap((section, index) => consumed.has(index) ? [] : [{ ...section, provided: true }])
  return [...canonical, ...additional]
}
