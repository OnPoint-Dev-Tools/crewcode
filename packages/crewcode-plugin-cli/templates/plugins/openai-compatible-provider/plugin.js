const ctx = document.getElementById('ctx')
window.crewcode.onContext(message => {
  ctx.textContent = `workspace: ${message.workspace?.name || 'none'} · source: ${message.openContext?.source || 'unknown'}`
})
