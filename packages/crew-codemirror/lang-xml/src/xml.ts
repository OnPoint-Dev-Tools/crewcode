import {parser} from "@lezer/xml"
import {SyntaxNode} from "@lezer/common"
import {indentNodeProp, foldNodeProp, LRLanguage, LanguageSupport, bracketMatchingHandle,
        syntaxTree} from "@codemirror/language"
import {EditorSelection, Text} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {ElementSpec, AttrSpec, completeFromSchema} from "./complete"
export {ElementSpec, AttrSpec, completeFromSchema}

/// A language provider based on the [Lezer XML
/// parser](https://code.haverbeke.berlin/lezer/xml), extended with
/// highlighting and indentation information.
export const xmlLanguage = LRLanguage.define({
  name: "xml",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        Element(context) {
          let closed = /^\s*<\//.test(context.textAfter)
          return context.lineIndent(context.node.from) + (closed ? 0 : context.unit)
        },
        "OpenTag CloseTag SelfClosingTag"(context) {
          return context.column(context.node.from) + context.unit
        }
      }),
      foldNodeProp.add({
        Element(subtree) {
          let first = subtree.firstChild, last = subtree.lastChild!
          if (!first || first.name != "OpenTag") return null
          return {from: first.to, to: last.name == "CloseTag" ? last.from : subtree.to}
        }
      }),
      bracketMatchingHandle.add({
        "OpenTag CloseTag": node => node.getChild("TagName")
      })
    ]
  }),
  languageData: {
    commentTokens: {block: {open: "<!--", close: "-->"}},
    indentOnInput: /^\s*<\/$/
  }
})

type XMLConfig = {
  /// Provide a schema to create completions from.
  elements?: readonly ElementSpec[]
  /// Supporting attribute descriptions for the schema specified in
  /// [`elements`](#lang-xml.xml^conf.elements).
  attributes?: readonly AttrSpec[]
  /// Determines whether [`autoCloseTags`](#lang-xml.autoCloseTags)
  /// is included in the support extensions. Defaults to true.
  autoCloseTags?: boolean
}

/// XML language support. Includes schema-based autocompletion when
/// configured.
export function xml(conf: XMLConfig = {}) {
  let support = [xmlLanguage.data.of({
    autocomplete: completeFromSchema(conf.elements || [], conf.attributes || [])
  })]
  if (conf.autoCloseTags !== false) support.push(autoCloseTags)
  return new LanguageSupport(xmlLanguage, support)
}

function elementName(doc: Text, tree: SyntaxNode | null | undefined, max = doc.length) {
  if (!tree) return ""
  let tag = tree.firstChild
  let name = tag && tag.getChild("TagName")
  return name ? doc.sliceString(name.from, Math.min(name.to, max)) : ""
}

/// Extension that will automatically insert close tags when a `>` or
/// `/` is typed.
export const autoCloseTags = EditorView.inputHandler.of((view, from, to, text, insertTransaction) => {
  if (view.composing || view.state.readOnly || from != to || (text != ">" && text != "/") ||
      !xmlLanguage.isActiveAt(view.state, from, -1)) return false
  let base = insertTransaction(), {state} = base
  let closeTags = state.changeByRange(range => {
    let {head} = range
    let didType = state.doc.sliceString(head - 1, head) == text
    let after = syntaxTree(state).resolveInner(head, -1), name
    if (didType && text == ">" && after.name == "EndTag") {
      let tag = after.parent!
      if (tag.parent?.lastChild?.name != "CloseTag" &&
          (name = elementName(state.doc, tag.parent, head))) {
        let to = head + (state.doc.sliceString(head, head + 1) === ">" ? 1 : 0)
        let insert = `</${name}>`
        return {range, changes: {from: head, to, insert}}
      }
    } else if (didType && text == "/" && after.name == "StartCloseTag") {
      let base = after.parent!
      if (after.from == head - 2 && base.lastChild?.name != "CloseTag" &&
          (name = elementName(state.doc, base, head))) {
        let to = head + (state.doc.sliceString(head, head + 1) === ">" ? 1 : 0)
        let insert = `${name}>`
        return {
          range: EditorSelection.cursor(head + insert.length, -1),
          changes: {from: head, to, insert}
        }
      }
    }
    return {range}
  })
  if (closeTags.changes.empty) return false
  view.dispatch([
    base,
    state.update(closeTags, {
      userEvent: "input.complete",
      scrollIntoView: true
    })
  ])
  return true
})
