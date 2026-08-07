const ctx = document.getElementById('ctx')

window.crewcode.onContext(message => {
  ctx.textContent = JSON.stringify({
    source: message.openContext?.source,
    workspace: message.workspace?.name,
    root: message.workspace?.root,
  }, null, 2)
})
