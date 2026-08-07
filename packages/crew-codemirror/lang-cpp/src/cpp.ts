import {parser} from "@lezer/cpp"
import {flatIndent, continuedIndent, delimitedIndent, indentNodeProp,
        foldNodeProp, foldInside,
        LRLanguage, LanguageSupport} from "@codemirror/language"

/// A language provider based on the [Lezer C++
/// parser](https://code.haverbeke.berlin/lezer/cpp), extended with
/// highlighting and indentation information.
export const cppLanguage = LRLanguage.define({
  name: "cpp",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        IfStatement: continuedIndent({except: /^\s*({|else\b)/}),
        TryStatement: continuedIndent({except: /^\s*({|catch)\b/}),
        LabeledStatement: flatIndent,
        CaseStatement: context => context.baseIndent + context.unit,
        BlockComment: () => null,
        CompoundStatement: delimitedIndent({closing: "}"}),
        Statement: continuedIndent({except: /^{/})
      }),
      foldNodeProp.add({
        "DeclarationList CompoundStatement EnumeratorList FieldDeclarationList InitializerList": foldInside,
        BlockComment(tree) { return {from: tree.from + 2, to: tree.to - 2} }
      })
    ]
  }),
  languageData: {
    commentTokens: {line: "//", block: {open: "/*", close: "*/"}},
    indentOnInput: /^\s*(?:case |default:|\{|\})$/,
    closeBrackets: {stringPrefixes: ["L", "u", "U", "u8", "LR", "UR", "uR", "u8R", "R"]}
  }
})

/// Language support for C++.
export function cpp() {
  return new LanguageSupport(cppLanguage)
}
