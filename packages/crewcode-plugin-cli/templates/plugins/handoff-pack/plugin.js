const els = {
  workspace: document.getElementById('workspace'),
  objective: document.getElementById('objective'),
  notes: document.getElementById('notes'),
  focus: document.getElementById('focus'),
  preview: document.getElementById('preview'),
  status: document.getElementById('status'),
  generate: document.getElementById('generate'),
  save: document.getElementById('save'),
  copy: document.getElementById('copy'),
  clear: document.getElementById('clear'),
}

let latestContext = null
let latestMarkdown = ''

function setStatus(message, danger = false) {
  els.status.textContent = message
  els.status.className = danger ? 'status error' : 'status'
}

function todayStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function escapeMd(value) {
  return String(value || '').trim()
}

async function readOptional(path) {
  try {
    const { text } = await window.crewcode.workspace.readFile(path)
    return text
  } catch {
    return ''
  }
}

function summarizePackageJson(text) {
  if (!text) return '- package metadata unavailable'
  try {
    const pkg = JSON.parse(text)
    const scripts = pkg.scripts ? Object.keys(pkg.scripts).slice(0, 12).join(', ') : 'none'
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).slice(0, 16).join(', ')
    return [`- package: ${pkg.name || 'unknown'}${pkg.version ? `@${pkg.version}` : ''}`, `- scripts: ${scripts}`, `- notable deps: ${deps || 'none listed'}`].join('\n')
  } catch {
    return '- package metadata could not be parsed'
  }
}

function fileStats(files) {
  const source = files.filter(file => /\.(ts|tsx|js|jsx|css|html|md|json|py|go|rs)$/i.test(file))
  const docs = files.filter(file => /(^|\/)(readme|docs\/|.*\.md$)/i.test(file))
  const tests = files.filter(file => /(test|spec)\.(ts|tsx|js|jsx)$/i.test(file))
  return [`- total files: ${files.length}`, `- source-like files: ${source.length}`, `- docs/markdown files: ${docs.length}`, `- test files: ${tests.length}`].join('\n')
}

async function generate() {
  els.generate.disabled = true
  els.generate.textContent = 'generating…'
  try {
    const ctx = latestContext
    const { files } = await window.crewcode.workspace.listFiles()
    const readmePath = files.find(file => /^readme\.md$/i.test(file)) || files.find(file => /(^|\/)readme\.md$/i.test(file))
    const packagePath = files.includes('package.json') ? 'package.json' : ''
    const readme = readmePath ? await readOptional(readmePath) : ''
    const pkg = packagePath ? await readOptional(packagePath) : ''
    const focusPaths = els.focus.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 8)
    const focusBlocks = []

    for (const path of focusPaths) {
      const text = await readOptional(path)
      focusBlocks.push(text
        ? `### ${path}\n\n\`\`\`\n${text.slice(0, 4000)}\n\`\`\``
        : `### ${path}\n\n_unavailable or too large_`)
    }

    latestMarkdown = [
      '# Handoff Pack',
      '',
      `Generated: ${new Date().toLocaleString()}`,
      `Workspace: ${ctx?.workspace?.name || 'unknown'} (${ctx?.workspace?.kind || 'unknown'})`,
      '',
      '## Objective',
      '',
      escapeMd(els.objective.value) || '_not specified_',
      '',
      '## Human notes',
      '',
      escapeMd(els.notes.value) || '_none provided_',
      '',
      '## Workspace snapshot',
      '',
      fileStats(files),
      '',
      '## Package metadata',
      '',
      summarizePackageJson(pkg),
      '',
      '## README excerpt',
      '',
      readme ? readme.slice(0, 2200) : '_README not found_',
      '',
      '## Focus files',
      '',
      focusBlocks.length ? focusBlocks.join('\n\n') : '_no focus paths provided_',
      '',
      '## Suggested next-agent checklist',
      '',
      '- Confirm current branch and pending changes.',
      '- Re-run relevant validation before editing broadly.',
      '- Preserve plugin security boundaries and remote workspace behavior.',
      '- Update docs if public plugin/API behavior changes.',
      '',
    ].join('\n')

    els.preview.textContent = latestMarkdown
    setStatus('handoff preview generated')
  } catch (err) {
    setStatus(err.message || 'failed to generate handoff', true)
  } finally {
    els.generate.disabled = false
    els.generate.textContent = 'generate'
  }
}

async function save() {
  if (!latestMarkdown) await generate()
  const path = `.crewcode/handoffs/handoff-${todayStamp()}.md`
  try {
    await window.crewcode.workspace.writeFile(path, latestMarkdown)
    setStatus(`saved ${path}`)
  } catch (err) {
    setStatus(err.message || 'failed to save handoff', true)
  }
}

window.crewcode.onContext(ctx => {
  latestContext = ctx
  els.workspace.textContent = ctx.workspace ? `${ctx.workspace.name} · ${ctx.workspace.kind}` : 'no active workspace'
})

els.generate.addEventListener('click', generate)
els.save.addEventListener('click', save)
els.copy.addEventListener('click', async () => {
  if (!latestMarkdown) await generate()
  await navigator.clipboard.writeText(latestMarkdown)
  setStatus('copied preview to clipboard')
})
els.clear.addEventListener('click', () => {
  els.notes.value = ''
  els.focus.value = ''
  latestMarkdown = ''
  els.preview.textContent = 'click generate to build a handoff pack.'
  setStatus('cleared local draft')
})
