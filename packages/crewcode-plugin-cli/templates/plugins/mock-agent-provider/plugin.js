window.crewcode.onContext(ctx => {
  document.getElementById('workspace').textContent = ctx.workspace ? `${ctx.workspace.name} · ${ctx.workspace.kind}` : 'no active workspace'
})
