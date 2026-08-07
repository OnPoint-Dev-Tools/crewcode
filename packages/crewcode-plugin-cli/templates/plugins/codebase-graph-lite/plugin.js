let context = null
let files = []

function showError(err) {
  document.getElementById('preview').textContent = `Error: ${err.message}`
}

function renderFiles() {
  const list = document.getElementById('files')
  list.innerHTML = ''
  document.getElementById('count').textContent = `${files.length} files`
  for (const rel of files.slice(0, 400)) {
    const li = document.createElement('li')
    li.textContent = rel
    li.className = 'mono'
    li.onclick = async () => {
      for (const item of list.querySelectorAll('li')) item.classList.remove('on')
      li.classList.add('on')
      try {
        const result = await window.crewcode.workspace.readFile(rel)
        document.getElementById('preview').textContent = result.text.slice(0, 12000)
      } catch (err) {
        showError(err)
      }
    }
    list.appendChild(li)
  }
}

async function loadFiles() {
  if (!context?.workspace) return
  document.getElementById('preview').textContent = 'Reading workspace file list through CrewCode…'
  const result = await window.crewcode.workspace.listFiles()
  files = result.files || []
  renderFiles()
  document.getElementById('preview').textContent = files.length
    ? 'Select a file to preview it. This panel is isolated; file reads go through CrewCode permissions.'
    : 'No files returned.'
}

window.crewcode.onContext(next => {
  context = next
  document.getElementById('workspace').textContent = next.workspace
    ? `${next.workspace.name} · ${next.workspace.kind} · permissions: ${next.permissions.join(', ') || 'none'}`
    : `no workspace · permissions: ${next.permissions.join(', ') || 'none'}`
  loadFiles().catch(showError)
})

document.getElementById('refresh').onclick = () => loadFiles().catch(showError)
