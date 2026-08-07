import {continuedIndent, indentNodeProp, foldNodeProp, foldInside, LRLanguage, LanguageSupport} from "@codemirror/language"
import {defineCSSCompletionSource} from "@codemirror/lang-css"
import {parser} from "./less.grammar"

/// A language provider for Less style sheets.
export const lessLanguage = LRLanguage.define({
  name: "less",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        Declaration: continuedIndent()
      }),
      foldNodeProp.add({
        Block: foldInside
      })
    ]
  }),
  languageData: {
    commentTokens: {block: {open: "/*", close: "*/"}, line: "//"},
    indentOnInput: /^\s*\}$/,
    wordChars: "@-"
  }
})

/// Property, variable, @-variable, and value keyword completion
/// source.
export const lessCompletionSource =
  defineCSSCompletionSource(node => node.name == "VariableName" || node.name == "AtKeyword")

/// Language support for Less.
export function less() {
  return new LanguageSupport(lessLanguage, lessLanguage.data.of({autocomplete: lessCompletionSource}));
}
