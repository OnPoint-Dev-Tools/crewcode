import {Completion, snippetCompletion as snip} from "@codemirror/autocomplete"

/// A collection of Go-related [snippets](#autocomplete.snippet).
export const snippets: readonly Completion[] = [
  snip("func ${name}(${params}) ${type} {\n\t${}\n}", {
    label: "func",
    detail: "declaration",
    type: "keyword"
  }),
  snip("func (${receiver}) ${name}(${params}) ${type} {\n\t${}\n}", {
    label: "func",
    detail: "method declaration",
    type: "keyword"
  }),
  snip("var ${name} = ${value}", {
    label: "var",
    detail: "declaration",
    type: "keyword"
  }),
  snip("type ${name} ${type}", {
    label: "type",
    detail: "declaration",
    type: "keyword"
  }),
  snip("const ${name} = ${value}", {
    label: "const",
    detail: "declaration",
    type: "keyword"
  }),
  snip("type ${name} = ${type}", {
    label: "type",
    detail: "alias declaration",
    type: "keyword"
  }),
  snip("for ${init}; ${test}; ${update} {\n\t${}\n}", {
    label: "for",
    detail: "loop",
    type: "keyword"
  }),
  snip("for ${i} := range ${value} {\n\t${}\n}", {
    label: "for",
    detail: "range",
    type: "keyword"
  }),
  snip("select {\n\t${}\n}", {
    label: "select",
    detail: "statement",
    type: "keyword"
  }),
  snip("case ${}:\n${}", {
    label: "case",
    type: "keyword"
  }),
  snip("switch ${} {\n\t${}\n}", {
    label: "switch",
    detail: "statement",
    type: "keyword"
  }),
  snip("switch ${}.(${type}) {\n\t${}\n}", {
    label: "switch",
    detail: "type statement",
    type: "keyword"
  }),
  snip("if ${} {\n\t${}\n}", {
    label: "if",
    detail: "block",
    type: "keyword"
  }),
  snip("if ${} {\n\t${}\n} else {\n\t${}\n}", {
    label: "if",
    detail: "/ else block",
    type: "keyword"
  }),
  snip("import ${name} \"${module}\"\n${}", {
    label: "import",
    detail: "declaration",
    type: "keyword"
  }),
]
