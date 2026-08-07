const out = document.getElementById('output')
const fileCount = document.getElementById('file-count')
const sourceCount = document.getElementById('source-count')
const docCount = document.getElementById('doc-count')
const refresh = document.getElementById('refresh')

function renderContext(ctx) {
  out.textContent = JSON.stringify({
    source: ctx.openContext?.source,
    workspace: ctx.workspace?.name,
    root: ctx.workspace?.root,
  }, null, 2)
}

async function loadSnapshot() {
  try {
    const result = await window.crewcode.workspace.listFiles()
    const files = result.files || []
    fileCount.textContent = String(files.length)
    sourceCount.textContent = String(files.filter(file => /\.(ts|tsx|js|jsx|css|html)$/.test(file)).length)
    docCount.textContent = String(files.filter(file => /\.(md|mdx|txt)$/.test(file)).length)
    out.textContent = files.slice(0, 80).join('\n') || 'no files found'
  } catch (err) {
    out.textContent = `plugin request failed: ${err.message}`
  }
}

window.crewcode.onContext(renderContext)
refresh.addEventListener('click', loadSnapshot)
void loadSnapshot()
