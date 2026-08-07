import {LRLanguage, LanguageSupport} from "@codemirror/language"
import {html} from "@codemirror/lang-html"
import {javascriptLanguage} from "@codemirror/lang-javascript"
import {styleTags, tags as t} from "@lezer/highlight"
import {parseMixed, SyntaxNodeRef, Input} from "@lezer/common"
import {parser} from "./angular.grammar"

const exprParser = javascriptLanguage.parser.configure({
  top: "SingleExpression"
})

const baseParser = parser.configure({
  props: [
    styleTags({
      Text: t.content,
      Is: t.definitionOperator,
      AttributeName: t.attributeName,
      "AttributeValue ExpressionAttributeValue StatementAttributeValue": t.attributeValue,
      Entity: t.character,
      InvalidEntity: t.invalid,
      "BoundAttributeName/Identifier": t.attributeName,
      "EventName/Identifier": t.special(t.attributeName),
      "ReferenceName/Identifier": t.variableName,
      "DirectiveName/Identifier": t.keyword,
      "{{ }}": t.brace,
      "( )": t.paren,
      "[ ]": t.bracket,
      "# '*'": t.punctuation
    })
  ]
})

const exprMixed = {parser: exprParser}, statementMixed = {parser: javascriptLanguage.parser}

const textParser = baseParser.configure({
  wrap: parseMixed((node, input) => node.name == "InterpolationContent" ? exprMixed : null),
})

const attrParser = baseParser.configure({
  wrap: parseMixed((node, input) => node.name == "InterpolationContent" ? exprMixed
    : node.name != "AttributeInterpolation" ? null
    : node.node.parent?.name == "StatementAttributeValue" ? statementMixed : exprMixed),
  top: "Attribute"
})

const textMixed = {parser: textParser}, attrMixed = {parser: attrParser}

const baseHTML = html({selfClosingTags: true})

function mkAngular(language: LRLanguage) {
  return language.configure({wrap: parseMixed(mixAngular)}, "angular")
}

/// A language provider for Angular Templates.
export const angularLanguage = mkAngular(baseHTML.language as LRLanguage)

function mixAngular(node: SyntaxNodeRef, input: Input) {
  switch (node.name) {
    case "Attribute":
      return /^[*#(\[]|\{\{/.test(input.read(node.from, node.to)) ? attrMixed : null
    case "Text":
      return textMixed
  }
  return null
}

/// Angular Template language support.
export function angular(config: {
  /// Provide an HTML language configuration to use as a base. _Must_
  /// be the result of calling `html()` from `@codemirror/lang-html`,
  /// not just any `LanguageSupport` object.
  base?: LanguageSupport
} = {}) {
  let base = baseHTML
  if (config.base) {
    if (config.base.language.name != "html" || !(config.base.language instanceof LRLanguage))
      throw new RangeError("The base option must be the result of calling html(...)")
    base = config.base
  }
  return new LanguageSupport(
    base.language == baseHTML.language ? angularLanguage : mkAngular(base.language as LRLanguage),
    [base.support, base.language.data.of({
      closeBrackets: {brackets: ["[", "{", '"']},
      indentOnInput: /^\s*[\}\]]$/
    })])
}
