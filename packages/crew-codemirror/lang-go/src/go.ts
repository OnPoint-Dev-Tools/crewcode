import {parser} from "@lezer/go"
import {LRLanguage, LanguageSupport, delimitedIndent, flatIndent, continuedIndent,
        indentNodeProp, foldNodeProp, foldInside} from "@codemirror/language"
import {completeFromList, ifNotIn} from "@codemirror/autocomplete"
import {snippets} from "./snippets"
import {localCompletionSource, dontComplete} from "./complete"

/// A language provider based on the [Lezer Go
/// parser](https://code.haverbeke.berlin/lezer/go), extended with
/// folding and indentation information.
export const goLanguage = LRLanguage.define({
  name: "go",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        IfStatement: continuedIndent({except: /^\s*({|else\b)/}),
        LabeledStatement: flatIndent,
        "SwitchBlock SelectBlock": context => {
          let after = context.textAfter, closed = /^\s*\}/.test(after), isCase = /^\s*(case|default)\b/.test(after)
          return context.baseIndent + (closed || isCase ? 0 : context.unit)
        },
        Block: delimitedIndent({closing: "}"}),
        BlockComment: () => null,
        Statement: continuedIndent({except: /^{/}),
      }),
      foldNodeProp.add({
        "Block SwitchBlock SelectBlock LiteralValue InterfaceType StructType SpecList": foldInside,
        BlockComment(tree) { return {from: tree.from + 2, to: tree.to - 2} }
      })
    ]
  }),
  languageData: {
    closeBrackets: {brackets: ["(", "[", "{", "'", '"', "`"]},
    commentTokens: {line: "//", block: {open: "/*", close: "*/"}},
    indentOnInput: /^\s*(?:case\b|default\b|\})$/
  }
})

let kwCompletion = (name: string) => ({label: name, type: "keyword"})

const keywords = "interface struct chan map package go return break continue goto fallthrough else defer range true false nil".split(" ").map(kwCompletion)

/// Go support. Includes [snippet](#lang-go.snippets) and local
/// variable completion.
export function go() {
  let completions = snippets.concat(keywords)
  return new LanguageSupport(goLanguage, [
    goLanguage.data.of({
      autocomplete: ifNotIn(dontComplete, completeFromList(completions))
    }),
    goLanguage.data.of({
      autocomplete: localCompletionSource
    })
  ])
}
