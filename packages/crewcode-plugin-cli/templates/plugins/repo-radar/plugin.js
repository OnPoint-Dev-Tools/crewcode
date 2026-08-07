const els = {
  workspace: document.getElementById('workspace'),
  filesCount: document.getElementById('filesCount'),
  todoCount: document.getElementById('todoCount'),
  riskCount: document.getElementById('riskCount'),
  todos: document.getElementById('todos'),
  risks: document.getElementById('risks'),
  mix: document.getElementById('mix'),
  scan: document.getElementById('scan'),
  clear: document.getElementById('clear'),
}

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|java|kt|swift|rb|php|yml|yaml|toml)$/i
const SKIP = /(^|\/)(node_modules|\.git|dist|out|build|\.next|coverage)(\/|$)/
const TODO_RE = /\b(todo|fixme|hack|xxx)\b/i

function setList(el, items, render, empty) {
  el.innerHTML = ''
  if (!items.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = empty
    el.appendChild(li)
    return
  }
  for (const item of items) {
    const li = document.createElement('li')
    li.innerHTML = render(item)
    el.appendChild(li)
  }
}

function extOf(file) {
  const match = file.match(/\.([^.\/]+)$/)
  return match ? match[1].toLowerCase() : 'none'
}

function riskSignals(files) {
  const out = []
  for (const file of files) {
    if (/(^|\/)\.env(\.|$)/.test(file)) out.push({ file, reason: 'environment file' })
    if (/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(file)) out.push({ file, reason: 'lockfile changed often' })
    if (/(^|\/)(generated|vendor)\//.test(file)) out.push({ file, reason: 'generated/vendor path' })
    if (/\.(pem|key|p12|pfx)$/i.test(file)) out.push({ file, reason: 'secret-like file extension' })
  }
  return out.slice(0, 12)
}

async function scan() {
  els.scan.disabled = true
  els.scan.textContent = 'scanning…'
  try {
    const { files } = await window.crewcode.workspace.listFiles()
    const sourceFiles = files.filter(file => TEXT_EXT.test(file) && !SKIP.test(file)).slice(0, 120)
    const todos = []
    const extensions = new Map()

    for (const file of files) extensions.set(extOf(file), (extensions.get(extOf(file)) || 0) + 1)

    for (const file of sourceFiles) {
      try {
        const { text } = await window.crewcode.workspace.readFile(file)
        const lines = text.split(/\r?\n/)
        lines.forEach((line, index) => {
          if (TODO_RE.test(line) && todos.length < 20) todos.push({ file, line: index + 1, text: line.trim().slice(0, 180) })
        })
      } catch {
        // Some files can be too large or disappear during a scan; keep radar resilient.
      }
    }

    const risks = riskSignals(files)
    const mix = [...extensions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([ext, count]) => ({ ext, count }))

    els.filesCount.textContent = String(files.length)
    els.todoCount.textContent = String(todos.length)
    els.riskCount.textContent = String(risks.length)
    setList(els.todos, todos, item => `<code>${item.file}:${item.line}</code><div class="line">${escapeHtml(item.text)}</div>`, 'no todo-style comments found')
    setList(els.risks, risks, item => `<code class="danger">${item.reason}</code><div class="line">${escapeHtml(item.file)}</div>`, 'no obvious risk signals found')
    setList(els.mix, mix, item => `<code>.${escapeHtml(item.ext)}</code><div class="line">${item.count} file${item.count === 1 ? '' : 's'}</div>`, 'no files found')
  } finally {
    els.scan.disabled = false
    els.scan.textContent = 'scan workspace'
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
}

window.crewcode.onContext(ctx => {
  els.workspace.textContent = ctx.workspace ? `${ctx.workspace.name} · ${ctx.workspace.kind}` : 'no active workspace'
})

els.scan.addEventListener('click', scan)
els.clear.addEventListener('click', () => {
  els.filesCount.textContent = '—'
  els.todoCount.textContent = '—'
  els.riskCount.textContent = '—'
  setList(els.todos, [], () => '', 'run a scan to inspect source comments')
  setList(els.risks, [], () => '', 'looks for env files, lockfiles, generated dirs, large source files')
  setList(els.mix, [], () => '', 'file extension summary appears here')
})
