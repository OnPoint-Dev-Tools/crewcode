import {parser} from "@lezer/sass"
import {LRLanguage, indentNodeProp, continuedIndent, foldNodeProp, foldInside, LanguageSupport} from "@codemirror/language"
import {defineCSSCompletionSource} from "@codemirror/lang-css"

/// A language provider based on the [Lezer Sass
/// parser](https://code.haverbeke.berlin/lezer/sass), extended with
/// highlighting and indentation information.
export const sassLanguage = LRLanguage.define({
  name: "sass",
  parser: parser.configure({
    props: [
      foldNodeProp.add({
        Block: foldInside,
        Comment(node, state) {
          return {from: node.from + 2, to: state.sliceDoc(node.to - 2, node.to) == "*/" ? node.to - 2 : node.to}
        }
      }),
      indentNodeProp.add({
        Declaration: continuedIndent()
      })
    ]
  }),
  languageData: {
    commentTokens: {block: {open: "/*", close: "*/"}, line: "//"},
    indentOnInput: /^\s*\}$/,
    wordChars: "$-"
  }
})

const indentedSassLanguage = sassLanguage.configure({
  dialect: "indented",
    props: [
      indentNodeProp.add({
        "Block RuleSet": cx => cx.baseIndent + cx.unit
      }),
      foldNodeProp.add({
        Block: node => ({from: node.from, to: node.to})
      })
    ]
})

/// Property, variable, $-variable, and value keyword completion
/// source.
export const sassCompletionSource =
  defineCSSCompletionSource(node => node.name == "VariableName" || node.name == "SassVariableName")

/// Language support for CSS.
export function sass(config?: {
  /// When enabled, support classical indentation-based syntax. Default
  /// to false (SCSS syntax).
  indented?: boolean
}) {
  return new LanguageSupport(
    config?.indented ? indentedSassLanguage : sassLanguage,
    sassLanguage.data.of({autocomplete: sassCompletionSource}))
}
