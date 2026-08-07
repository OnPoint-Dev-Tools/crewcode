import {Language, LRLanguage, LanguageSupport, foldNodeProp,
        indentNodeProp, delimitedIndent, TreeIndentContext} from "@codemirror/language"
import {html} from "@codemirror/lang-html"
import {styleTags, tags as t} from "@lezer/highlight"
import {parseMixed} from "@lezer/common"
import {parser} from "./jinja.grammar"

import {jinjaCompletionSource, JinjaCompletionConfig, closePercentBrace} from "./complete"
export {jinjaCompletionSource, JinjaCompletionConfig, closePercentBrace}

function statementIndent(except: RegExp) {
  return (context: TreeIndentContext) => {
    let back = except.test(context.textAfter)
    return context.lineIndent(context.node.from) + (back ? 0 : context.unit)
  }
}

const tagLanguage = LRLanguage.define({
  name: "jinja",
  parser: parser.configure({
    props: [
      styleTags({
        "TagName raw endraw filter endfilter as trans pluralize endtrans with endwith autoescape endautoescape": t.keyword,
        "required scoped recursive with without context ignore missing": t.modifier,
        "self": t.self,
        "loop super": t.standard(t.variableName),
        "if elif else endif for endfor call endcall": t.controlKeyword,
        "block endblock set endset macro endmacro import from include": t.definitionKeyword,
        "Comment/...": t.blockComment,
        "VariableName": t.variableName,
        "Definition": t.definition(t.variableName),
        "PropertyName": t.propertyName,
        "FilterName": t.special(t.variableName),
        "ArithOp": t.arithmeticOperator,
        "AssignOp": t.definitionOperator,
        "not and or": t.logicOperator,
        "CompareOp": t.compareOperator,
        "in is": t.operatorKeyword,
        "FilterOp ConcatOp": t.operator,
        "StringLiteral": t.string,
        "NumberLiteral": t.number,
        "BooleanLiteral": t.bool,
        "{% %} {# #} {{ }} { }": t.brace,
        "( )": t.paren,
        ".": t.derefOperator,
        ": , .": t.punctuation,
      }),
      indentNodeProp.add({
        Tag: delimitedIndent({closing: "%}"}),
        "IfStatement ForStatement": statementIndent(/^\s*(\{%-?\s*)?(endif|endfor|else|elif)\b/),
        "Statement": statementIndent(/^\s*(\{%-?\s*)?end\w/),
      }),
      foldNodeProp.add({
        "Statement Comment"(tree) {
          let first = tree.firstChild, last = tree.lastChild!
          if (!first || first.name != "Tag" && first.name != "{#") return null
          return {from: first.to, to: last.name == "EndTag" || last.name == "#}" ? last.from : tree.to}
        }
      })
    ]
  }),
  languageData: {
    indentOnInput: /^\s*{%-?\s*(?:end|elif|else)$/
  }
})

const baseHTML = html()

function makeJinja(base: Language) {
  return tagLanguage.configure({
    wrap: parseMixed(node => node.type.isTop ? {
      parser: base.parser,
      overlay: n => n.name == "Text" || n.name == "RawText"
    } : null)
  }, "jinja")
}

/// A language provider for Jinja templates.
export const jinjaLanguage = makeJinja(baseHTML.language)

/// Jinja template support.
export function jinja(config: JinjaCompletionConfig & {
  /// Provide an HTML language configuration to use as a base.
  base?: LanguageSupport
} = {}) {
  let base = config.base || baseHTML
  let lang = base.language == baseHTML.language ? jinjaLanguage : makeJinja(base.language)
  return new LanguageSupport(lang, [
    base.support,
    lang.data.of({autocomplete: jinjaCompletionSource(config)}),
    base.language.data.of({closeBrackets: {brackets: ["{"]}}),
    closePercentBrace
  ])
}
