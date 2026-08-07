import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { acceptCompletion, autocompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, redo as cmRedo, redoDepth, undo as cmUndo, undoDepth } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { lintGutter } from '@codemirror/lint'
import { LSPPlugin, serverCompletionSource, type LSPClient } from '@codemirror/lsp-client'
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection, WidgetType, type ViewUpdate } from '@codemirror/view'
import type { EditorThemeId } from '../../../../shared/editor-theme-types'
import { editorThemeExtension } from './editor-theme-registry'
import { extractTextOutline, type EditorOutlineKind, type EditorOutlineSymbol } from './editor-outline'

export type CodeMirrorCursor = { start: number; end: number }
export type CodeMirrorScroll = { top: number; left: number }

export type CrewCodeMirrorHandle = {
  focus: () => void
  hasFocus: () => boolean
  getCursor: () => CodeMirrorCursor
  getScroll: () => CodeMirrorScroll
  setSelection: (start: number, end: number) => void
  setScroll: (scroll: CodeMirrorScroll) => void
  scrollToLine: (line: number) => CodeMirrorCursor
  undo: () => boolean
  redo: () => boolean
  canUndo: () => boolean
  canRedo: () => boolean
}

type CrewCodeMirrorEditorProps = {
  rel: string
  name: string
  text: string
  cursor?: CodeMirrorCursor
  scroll?: CodeMirrorScroll
  searchMatch?: { term: string; caseSensitive: boolean } | null
  ghostText?: string | null
  theme?: EditorThemeId
  languageServer?: { client: LSPClient; uri: string; languageId: 'typescript' | 'javascript' } | null
  onDefinition?: (uri: string, line: number, column: number) => void
  onCodeActions?: (range: { start: { line: number; character: number }; end: { line: number; character: number } }) => void
  onFindReferences?: (position: { line: number; character: number }) => void
  onRenameSymbol?: (position: { line: number; character: number }) => void
  onOutlineChange?: (symbols: EditorOutlineSymbol[]) => void
  onChange: (text: string) => void
  onUserInput?: () => void
  onCursorChange?: (cursor: CodeMirrorCursor) => void
  onScrollChange?: (scroll: CodeMirrorScroll) => void
  onContextMenu?: (event: MouseEvent, cursor: CodeMirrorCursor) => void
}

function languageForName(name: string): Extension {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return javascript({ typescript: true, jsx: ext === 'tsx' })
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return javascript({ jsx: ext === 'jsx' })
  if (ext === 'json' || ext === 'jsonc') return json()
  if (ext === 'css' || ext === 'scss' || ext === 'less') return css()
  if (ext === 'html' || ext === 'xml' || ext === 'svg') return html()
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return markdown()
  if (ext === 'py') return python()
  if (ext === 'rs') return rust()
  return []
}

function localWordCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[A-Za-z_$][\w$]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null

  const current = word.text
  const seen = new Set<string>()
  const options: Completion[] = []
  const text = context.state.doc.toString()
  const re = /[A-Za-z_$][\w$]{2,}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const label = match[0]
    if (label === current || seen.has(label)) continue
    seen.add(label)
    options.push({ label, type: /^[A-Z]/.test(label) ? 'class' : 'variable' })
    if (options.length >= 200) break
  }

  return {
    from: word.from,
    options: options.sort((a, b) => a.label.localeCompare(b.label)),
    validFor: /^[A-Za-z_$][\w$]*$/,
  }
}

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) { super() }

  eq(other: GhostTextWidget): boolean { return other.text === this.text }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ghost-text'
    span.textContent = this.text
    return span
  }

  ignoreEvent(): boolean { return true }
}

type GhostTextState = { text: string; pos: number; decorations: DecorationSet } | null
const setGhostText = StateEffect.define<string | null>()
const setSearchMatches = StateEffect.define<{ term: string; caseSensitive: boolean } | null>()
const searchMatchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    const effect = transaction.effects.find(candidate => candidate.is(setSearchMatches))
    if (!effect && !transaction.docChanged) return value.map(transaction.changes)
    const search = effect?.value
    if (!search?.term) return Decoration.none
    const source = transaction.state.doc.toString()
    const haystack = search.caseSensitive ? source : source.toLowerCase()
    const needle = search.caseSensitive ? search.term : search.term.toLowerCase()
    const ranges: Range<Decoration>[] = []
    let from = 0
    while (ranges.length < 2_000) {
      const index = haystack.indexOf(needle, from)
      if (index < 0) break
      ranges.push(Decoration.mark({ class: 'cm-search-match' }).range(index, index + needle.length))
      from = index + Math.max(1, needle.length)
    }
    return Decoration.set(ranges)
  },
  provide: field => EditorView.decorations.from(field),
})
const ghostTextField = StateField.define<GhostTextState>({
  create: () => null,
  update(value, transaction) {
    const effect = transaction.effects.find(candidate => candidate.is(setGhostText))
    if (effect) {
      if (!effect.value) return null
      const pos = transaction.state.selection.main.head
      return {
        text: effect.value,
        pos,
        decorations: Decoration.set([Decoration.widget({ widget: new GhostTextWidget(effect.value), side: 1 }).range(pos)]),
      }
    }
    // A completion is valid only at the exact cursor/edit state that requested it.
    if (transaction.docChanged || transaction.selection) return null
    return value
  },
  provide: field => EditorView.decorations.from(field, value => value?.decorations ?? Decoration.none),
})

function acceptGhostText(view: EditorView): boolean {
  const ghost = view.state.field(ghostTextField)
  if (!ghost) return false
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: EditorSelection.cursor(ghost.pos + ghost.text.length),
  })
  return true
}

const tabKeymap = keymap.of([
  {
    key: 'Tab',
    run: view => acceptGhostText(view) || acceptCompletion(view) || indentWithTab.run?.(view) === true,
    shift: indentWithTab.shift,
  },
])

const crewTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text, #d8e2dc)',
    backgroundColor: 'transparent',
    // Consume the live typography vars (set by useSettingsEffects) so the global
    // mono font and the editor-override font/size actually reach the editor.
    fontFamily: 'var(--editor-family, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: 'var(--editor-size, 13px)',
    fontWeight: 'var(--editor-weight, 400)',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'var(--editor-line-height, 1.55)',
  },
  '.cm-content': {
    caretColor: 'var(--text, #d8e2dc)',
    padding: '12px 0 24px 0',
  },
  '.cm-line': {
    padding: '0 16px',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted, #6d7f78)',
    borderRight: '1px solid var(--border, #1c2f2f)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(40, 90, 72, 0.18)',
    color: 'var(--text, #d8e2dc)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(40, 90, 72, 0.10)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(40, 90, 72, 0.45)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel, #121812)',
    border: '1px solid var(--border, #1c2f2f)',
    color: 'var(--text, #d8e2dc)',
    boxShadow: 'none',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent, #285a48)',
    color: 'var(--text, #d8e2dc)',
  },
})

export const CrewCodeMirrorEditor = forwardRef<CrewCodeMirrorHandle, CrewCodeMirrorEditorProps>(function CrewCodeMirrorEditor({
  rel,
  name,
  text,
  cursor,
  scroll,
  searchMatch,
  ghostText,
  theme = 'crewcode',
  languageServer,
  onDefinition,
  onCodeActions,
  onFindReferences,
  onRenameSymbol,
  onOutlineChange,
  onChange,
  onUserInput,
  onCursorChange,
  onScrollChange,
  onContextMenu,
}, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartmentRef = useRef(new Compartment())
  const applyingExternalTextRef = useRef(false)
  const outlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleOutlineRef = useRef<(view: EditorView, immediate?: boolean) => void>(() => {})
  const onChangeRef = useRef(onChange)
  const onUserInputRef = useRef(onUserInput)
  const onCursorChangeRef = useRef(onCursorChange)
  const onScrollChangeRef = useRef(onScrollChange)
  const onContextMenuRef = useRef(onContextMenu)
  const onDefinitionRef = useRef(onDefinition)
  const onCodeActionsRef = useRef(onCodeActions)
  const onFindReferencesRef = useRef(onFindReferences)
  const onRenameSymbolRef = useRef(onRenameSymbol)
  const onOutlineChangeRef = useRef(onOutlineChange)
  onChangeRef.current = onChange
  onUserInputRef.current = onUserInput
  onCursorChangeRef.current = onCursorChange
  onScrollChangeRef.current = onScrollChange
  onContextMenuRef.current = onContextMenu
  onDefinitionRef.current = onDefinition
  onCodeActionsRef.current = onCodeActions
  onFindReferencesRef.current = onFindReferences
  onRenameSymbolRef.current = onRenameSymbol
  onOutlineChangeRef.current = onOutlineChange

  scheduleOutlineRef.current = (view, immediate = false) => {
    if (outlineTimerRef.current) clearTimeout(outlineTimerRef.current)
    outlineTimerRef.current = setTimeout(() => {
      outlineTimerRef.current = null
      const startDoc = view.state.doc
      const fallback = () => {
        if (view.state.doc === startDoc) onOutlineChangeRef.current?.(extractTextOutline(name, startDoc.toString()))
      }
      if (!languageServer) { fallback(); return }
      languageServer.client.sync()
      void languageServer.client.request<
        { textDocument: { uri: string } },
        Array<{
          name: string
          kind: number
          range?: { start: { line: number; character: number } }
          selectionRange?: { start: { line: number; character: number } }
          location?: { range: { start: { line: number; character: number } } }
          children?: unknown[]
        }> | null
      >('textDocument/documentSymbol', { textDocument: { uri: languageServer.uri } }).then(items => {
        if (view.state.doc !== startDoc || !items) return
        const symbols: EditorOutlineSymbol[] = []
        const add = (item: (typeof items)[number], depth: number) => {
          const start = item.selectionRange?.start ?? item.range?.start ?? item.location?.range.start
          if (!start) return
          const kindMap: Record<number, EditorOutlineKind> = {
            2: 'module', 3: 'module', 4: 'module', 5: 'class', 6: 'method', 7: 'variable',
            8: 'variable', 9: 'function', 10: 'enum', 11: 'interface', 12: 'function',
            13: 'variable', 14: 'variable', 22: 'enum', 23: 'class', 26: 'type',
          }
          symbols.push({
            id: `${start.line + 1}:${start.character}:${item.kind}:${item.name}`,
            name: item.name,
            kind: kindMap[item.kind] ?? 'variable',
            line: start.line + 1,
            column: start.character,
            depth,
          })
          for (const child of item.children ?? []) add(child as (typeof items)[number], depth + 1)
        }
        for (const item of items) add(item, 0)
        onOutlineChangeRef.current?.(symbols)
      }).catch(fallback)
    }, immediate ? 0 : 250)
  }

  const extensions = useMemo<Extension[]>(() => [
    lineNumbers(),
    // Keep source and Markdown documents readable in split panes without
    // changing the underlying file's newlines or line-number semantics.
    EditorView.lineWrapping,
    foldGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    bracketMatching(),
    indentOnInput(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    languageForName(name),
    lintGutter(),
    languageServer?.client.plugin(languageServer.uri, languageServer.languageId) ?? [],
    autocompletion({ override: [serverCompletionSource, localWordCompletions], activateOnTyping: true }),
    ghostTextField,
    searchMatchField,
    tabKeymap,
    keymap.of([
      {
        key: 'Mod-.',
        preventDefault: true,
        run(view) {
          const plugin = LSPPlugin.get(view)
          if (!plugin) return false
          const selection = view.state.selection.main
          onCodeActionsRef.current?.({
            start: plugin.toPosition(selection.from),
            end: plugin.toPosition(selection.to),
          })
          return true
        },
      },
      {
        key: 'Shift-F12',
        preventDefault: true,
        run(view) {
          const plugin = LSPPlugin.get(view)
          if (!plugin) return false
          onFindReferencesRef.current?.(plugin.toPosition(view.state.selection.main.head))
          return true
        },
      },
      {
        key: 'F2',
        preventDefault: true,
        run(view) {
          const plugin = LSPPlugin.get(view)
          if (!plugin) return false
          onRenameSymbolRef.current?.(plugin.toPosition(view.state.selection.main.head))
          return true
        },
      },
      {
        key: 'F12',
        preventDefault: true,
        run(view) {
          const plugin = LSPPlugin.get(view)
          if (!plugin || plugin.client.serverCapabilities?.definitionProvider === false) return false
          plugin.client.sync()
          void plugin.client.request<
            { textDocument: { uri: string }; position: { line: number; character: number } },
            { uri: string; range: { start: { line: number; character: number } } } | Array<{ uri: string; range: { start: { line: number; character: number } } }> | null
          >('textDocument/definition', {
            textDocument: { uri: plugin.uri },
            position: plugin.toPosition(view.state.selection.main.head),
          }).then(result => {
            const location = Array.isArray(result) ? result[0] : result
            if (location) onDefinitionRef.current?.(location.uri, location.range.start.line + 1, location.range.start.character)
          }).catch(error => console.warn('[lsp] definition failed', error))
          return true
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    crewTheme,
    themeCompartmentRef.current.of(editorThemeExtension(theme)),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged && !applyingExternalTextRef.current) {
        onChangeRef.current(update.state.doc.toString())
        const hasCodeInput = update.transactions.some(transaction => {
          if (!transaction.isUserEvent('input')) return false
          let insertedCode = false
          transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
            if (/\S/.test(inserted.toString())) insertedCode = true
          })
          return insertedCode
        })
        // Return and whitespace are input events, but not useful completion anchors.
        if (hasCodeInput) onUserInputRef.current?.()
      }
      if (update.docChanged) scheduleOutlineRef.current(update.view)
      if (update.selectionSet || update.docChanged) {
        const range = update.state.selection.main
        onCursorChangeRef.current?.({ start: range.from, end: range.to })
      }
    }),
    EditorView.domEventHandlers({
      scroll(event, view) {
        if (event.target !== view.scrollDOM) return
        onScrollChangeRef.current?.({ top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft })
      },
      contextmenu(event, view) {
        const range = view.state.selection.main
        onContextMenuRef.current?.(event, { start: range.from, end: range.to })
      },
    }),
  ], [name, languageServer?.client, languageServer?.uri, languageServer?.languageId])

  useEffect(() => {
    if (!hostRef.current) return
    const selection = cursor
      ? EditorSelection.single(Math.min(cursor.start, text.length), Math.min(cursor.end, text.length))
      : EditorSelection.cursor(0)
    const state = EditorState.create({ doc: text, selection, extensions })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    scheduleOutlineRef.current(view, true)
    requestAnimationFrame(() => {
      if (scroll) {
        view.scrollDOM.scrollTop = scroll.top
        view.scrollDOM.scrollLeft = scroll.left
      }
      view.focus()
    })
    return () => {
      if (outlineTimerRef.current) clearTimeout(outlineTimerRef.current)
      view.destroy()
      viewRef.current = null
    }
  }, [rel, extensions])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === text) return
    applyingExternalTextRef.current = true
    view.dispatch({ changes: { from: 0, to: current.length, insert: text } })
    applyingExternalTextRef.current = false
  }, [text])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setGhostText.of(ghostText?.trimEnd() || null) })
  }, [ghostText])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setSearchMatches.of(searchMatch?.term ? searchMatch : null) })
  }, [searchMatch])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: themeCompartmentRef.current.reconfigure(editorThemeExtension(theme)) })
  }, [theme])

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    hasFocus: () => viewRef.current?.hasFocus ?? false,
    getCursor: () => {
      const range = viewRef.current?.state.selection.main
      return range ? { start: range.from, end: range.to } : { start: 0, end: 0 }
    },
    getScroll: () => {
      const scroller = viewRef.current?.scrollDOM
      return scroller ? { top: scroller.scrollTop, left: scroller.scrollLeft } : { top: 0, left: 0 }
    },
    setSelection: (start, end) => {
      const view = viewRef.current
      if (!view) return
      const length = view.state.doc.length
      view.dispatch({ selection: EditorSelection.single(Math.min(start, length), Math.min(end, length)), scrollIntoView: true })
      view.focus()
    },
    setScroll: ({ top, left }) => {
      const scroller = viewRef.current?.scrollDOM
      if (!scroller) return
      scroller.scrollTop = top
      scroller.scrollLeft = left
    },
    scrollToLine: line => {
      const view = viewRef.current
      if (!view) return { start: 0, end: 0 }
      const safeLine = Math.max(1, Math.min(line, view.state.doc.lines))
      const pos = view.state.doc.line(safeLine).from
      view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      view.focus()
      return { start: pos, end: pos }
    },
    undo: () => viewRef.current ? cmUndo(viewRef.current) : false,
    redo: () => viewRef.current ? cmRedo(viewRef.current) : false,
    canUndo: () => viewRef.current ? undoDepth(viewRef.current.state) > 0 : false,
    canRedo: () => viewRef.current ? redoDepth(viewRef.current.state) > 0 : false,
  }), [])

  return <div className="ed-cm-host" ref={hostRef} />
})
