import type * as lsp from "vscode-languageserver-protocol"
import {setDiagnostics} from "@codemirror/lint"
import {ViewPlugin, ViewUpdate} from "@codemirror/view"
import {LSPPlugin} from "./plugin"
import {LSPClientExtension} from "./client"
  
function toSeverity(sev: lsp.DiagnosticSeverity) {
  return sev == 1 ? "error" : sev == 2 ? "warning" : sev == 3 ? "info" : "hint"
}

const autoSync = ViewPlugin.fromClass(class {
  pending = -1
  update(update: ViewUpdate) {
    if (update.docChanged) {
      if (this.pending > -1) clearTimeout(this.pending)
      this.pending = setTimeout(() => {
        this.pending = -1
        let plugin = LSPPlugin.get(update.view)
        if (plugin) plugin.client.sync()
      }, 500)
    }
  }
  destroy() {
    if (this.pending > -1) clearTimeout(this.pending)
  }
})

export function serverDiagnostics(): LSPClientExtension {
  return {
    clientCapabilities: {textDocument: {publishDiagnostics: {versionSupport: true}}},
    notificationHandlers: {
      "textDocument/publishDiagnostics": (client, params: lsp.PublishDiagnosticsParams) => {
        let file = client.workspace.getFile(params.uri)
        if (!file || params.version != null && params.version != file.version) return false
        const view = file.getView(), plugin = view && LSPPlugin.get(view)
        if (!view || !plugin) return false
        view.dispatch(setDiagnostics(view.state, params.diagnostics.map(item => ({
          from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
          to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
          severity: toSeverity(item.severity ?? 1),
          message: item.message,
        }))))
        return true
      }
    },
    editorExtension: autoSync
  }
}
