import {parser} from "@lezer/lezer"
import {LRLanguage, foldNodeProp, foldInside, LanguageSupport} from "@codemirror/language"

/// A language provider based on the [Lezer Lezer
/// parser](https://code.haverbeke.berlin/lezer/lezer-grammar), extended
/// with highlighting and indentation information.
export const lezerLanguage = LRLanguage.define({
  name: "lezer",
  parser: parser.configure({
    props: [
      foldNodeProp.add({
        "Body TokensBody SkipBody PrecedenceBody": foldInside
      })
    ]
  }),
  languageData: {
    commentTokens: {block: {open: "/*", close: "*/"}, line: "//"},
    indentOnInput: /^\s*\}$/
  }
})

/// Language support for Lezer grammars.
export function lezer() {
  return new LanguageSupport(lezerLanguage)
}
