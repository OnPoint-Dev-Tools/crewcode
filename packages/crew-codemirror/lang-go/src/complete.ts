import {NodeWeakMap, SyntaxNodeRef, SyntaxNode, IterMode} from "@lezer/common"
import {Completion, CompletionSource} from "@codemirror/autocomplete"
import {syntaxTree} from "@codemirror/language"
import {Text} from "@codemirror/state"

const cache = new NodeWeakMap<readonly Completion[]>()

const ScopeNodes = new Set([
  "SourceFile", "Block",
  "FunctionDecl", "MethodDecl", "FunctionLiteral",
  "ForStatement", "SwitchStatement", "TypeSwitchStatement", "IfStatement",
])

function defIDs(type: string, spec?: string) {
  return (node: SyntaxNodeRef, def: (node: SyntaxNodeRef, type: string) => void) => {
    outer: for (let cur = node.node.firstChild, depth = 0, parent: SyntaxNode | null = null;;) {
      while (!cur) {
        if (!depth) break outer
        depth--
        cur = parent!.nextSibling
        parent = parent!.parent
      }
      if (spec && cur.name == spec || cur.name == "SpecList") {
        depth++
        parent = cur
        cur = cur.firstChild
      } else {
        if (cur.name == "DefName") def(cur!, type)
        cur = cur.nextSibling
      }
    }
    return true
  }
}

const gatherCompletions: {
  [node: string]: (node: SyntaxNodeRef, def: (node: SyntaxNodeRef, type: string) => void) => void | boolean
} = {
  FunctionDecl: defIDs("function"),
  VarDecl: defIDs("var", "VarSpec"),
  ConstDecl: defIDs("constant", "ConstSpec"),
  TypeDecl: defIDs("type", "TypeSpec"),
  ImportDecl: defIDs("constant", "ImportSpec"),
  Parameter: defIDs("var"),
  __proto__: null as any
}

function getScope(doc: Text, node: SyntaxNode) {
  let cached = cache.get(node)
  if (cached) return cached

  let completions: Completion[] = [], top = true
  function def(node: SyntaxNodeRef, type: string) {
    let name = doc.sliceString(node.from, node.to)
    completions.push({label: name, type})
  }
  node.cursor(IterMode.IncludeAnonymous).iterate(node => {
    if (top) {
      top = false
    } else if (node.name) {
      let gather = gatherCompletions[node.name]
      if (gather && gather(node, def) || ScopeNodes.has(node.name)) return false
    } else if (node.to - node.from > 8192) {
      // Allow caching for bigger internal nodes
      for (let c of getScope(doc, node.node)) completions.push(c)
      return false
    }
  })
  cache.set(node, completions)
  return completions
}

const Identifier = /^[\w$\xa1-\uffff][\w$\d\xa1-\uffff]*$/

export const dontComplete = [
  "String", "LineComment", "BlockComment",
  "DefName", "LabelName", "FieldName",
  ".", "?."
]

/// Completion source that looks up locally defined names in Go code.
export const localCompletionSource: CompletionSource = context => {
  let inner = syntaxTree(context.state).resolveInner(context.pos, -1)
  if (dontComplete.indexOf(inner.name) > -1) return null
  let isWord = inner.name == "VariableName" ||
    inner.to - inner.from < 20 && Identifier.test(context.state.sliceDoc(inner.from, inner.to))
  if (!isWord && !context.explicit) return null
  let options: Completion[] = []
  for (let pos: SyntaxNode | null = inner; pos; pos = pos.parent) {
    if (ScopeNodes.has(pos.name)) options = options.concat(getScope(context.state.doc, pos))
  }
  return {
    options,
    from: isWord ? inner.from : context.pos,
    validFor: Identifier
  }
}
