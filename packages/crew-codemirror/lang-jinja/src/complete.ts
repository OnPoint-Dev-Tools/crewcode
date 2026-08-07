import {EditorState, EditorSelection} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {syntaxTree} from "@codemirror/language"
import {CompletionContext, CompletionResult, Completion} from "@codemirror/autocomplete"
import {SyntaxNode} from "@lezer/common"

function completions(words: string, type: string): readonly Completion[] {
  return words.split(" ").map(label => ({label, type}))
}

const Filters = completions(
  "abs attr batch capitalize center default dictsort escape filesizeformat first float " +
  "forceescape format groupby indent int items join last length list lower map max min " + 
  "pprint random reject rejectattr replace reverse round safe select selectattr slice " +
  "sort string striptags sum title tojson trim truncate unique upper urlencode urlize wordcount " +
  "wordwrap xmlattr", "function")

const Functions = completions(
  "boolean callable defined divisibleby eq escaped even filter float ge gt in integer " +
  "iterable le lower lt mapping ne none number odd sameas sequence string test undefined " +
  "upper range lipsum dict joiner namespace", "function")

const Globals = completions(
  "loop super self true false varargs kwargs caller name arguments catch_kwargs catch_varargs caller",
  "keyword")

const Expressions = Functions.concat(Globals)

const Tags = completions(
  "raw endraw filter endfilter trans pluralize endtrans with endwith autoescape endautoescape " +
  "if elif else endif for endfor call endcall block endblock set endset macro endmacro import " +
  "include break continue debug do extends", "keyword")

function findContext(context: CompletionContext): {type: string, node?: SyntaxNode, target?: SyntaxNode, from?: number} | null {
  let {state, pos} = context
  let node = syntaxTree(state).resolveInner(pos, -1).enterUnfinishedNodesBefore(pos)
  let before = node.childBefore(pos)?.name || node.name
  if (node.name == "FilterName")
    return {type: "filter", node}
  if (context.explicit && (before == "FilterOp" || before == "filter"))
    return {type: "filter"}
  if (node.name == "TagName")
    return {type: "tag", node}
  if (context.explicit && before == "{%")
    return {type: "tag"}
  if (node.name == "PropertyName" && node.parent!.name == "MemberExpression")
    return {type: "prop", node, target: node.parent!}
  if (node.name == "." && node.parent!.name == "MemberExpression")
    return {type: "prop", target: node.parent!}
  if (node.name == "MemberExpression" && before == ".")
    return {type: "prop", target: node}
  if (node.name == "VariableName")
    return {type: "expr", from: node.from}
  if (node.name == "Comment" || node.name == "StringLiteral" || node.name == "NumberLiteral") return null
  let word = context.matchBefore(/[\w\u00c0-\uffff]+$/)
  if (word) return {type: "expr", from: word.from}
  if (context.explicit) return {type: "expr"}
  return null
}

/// Configuration options to
/// [`jinjaCompletionSource`](#lang-jinja.jinjaCompletionSource).
export type JinjaCompletionConfig = {
  /// Adds additional completions when completing a Jinja tag.
  tags?: readonly Completion[],
  /// Add additional global variables.
  variables?: readonly Completion[],
  /// Provides completions for properties completed under the given
  /// path. For example, when completing `user.address.`, `path` will
  /// be `["user", "address"]`.
  properties?: (path: readonly string[], state: EditorState, context: CompletionContext) => readonly Completion[]
}

function resolveProperties(
  state: EditorState, node: SyntaxNode, context: CompletionContext,
  properties: (path: readonly string[], state: EditorState, context: CompletionContext) => readonly Completion[]
) {
  let path = []
  for (;;) {
    let obj = node.getChild("Expression")
    if (!obj) return []
    if (obj.name == "VariableName") {
      path.unshift(state.sliceDoc(obj.from, obj.to))
      break
    } else if (obj.name == "MemberExpression") {
      let name = obj.getChild("PropertyName")
      if (name) path.unshift(state.sliceDoc(name.from, name.to))
      node = obj
    } else {
      return []
    }
  }
  return properties(path, state, context)
}

/// Returns a completion source for jinja templates. Optionally takes
/// a configuration that adds additional custom completions.
export function jinjaCompletionSource(config: JinjaCompletionConfig = {}) {
  let tags = config.tags ? config.tags.concat(Tags) : Tags
  let exprs = config.variables ? config.variables.concat(Expressions) : Expressions
  let {properties} = config
  return (context: CompletionContext): CompletionResult | null => {
    let cx = findContext(context)
    if (!cx) return null
    let from = cx.from ?? (cx.node ? cx.node.from : context.pos)
    let options
    if (cx.type == "filter") options = Filters
    else if (cx.type == "tag") options = tags
    else if (cx.type == "expr") options = exprs
    else /* prop */ options = properties ? resolveProperties(context.state, cx.target!, context, properties) : []
    return options.length ? {options, from, validFor: /^[\w\u00c0-\uffff]*$/} : null
  }
}

/// This extension will, when the user types a `%` between two
/// matching braces, insert two percent signs instead and put the
/// cursor between them.
export const closePercentBrace = EditorView.inputHandler.of((view, from, to, text) => {
  if (text != "%" || from != to || view.state.doc.sliceString(from - 1, to + 1) != "{}")
    return false
  view.dispatch(view.state.changeByRange(range => ({
    changes: {from: range.from, to: range.to, insert: "%%"},
    range: EditorSelection.cursor(range.from + 1)
  })), {
    scrollIntoView: true,
    userEvent: "input.type"
  })
  return true
})
