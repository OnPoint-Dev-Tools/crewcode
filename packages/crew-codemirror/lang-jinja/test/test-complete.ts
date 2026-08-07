import {EditorState} from "@codemirror/state"
import {CompletionContext, CompletionResult, CompletionSource} from "@codemirror/autocomplete"
import {jinja} from "@codemirror/lang-jinja"
import ist from "ist"

function get(doc: string, config?: Parameters<typeof jinja>[0], explicit = true) {
  let cur = doc.indexOf("@")
  doc = doc.slice(0, cur) + doc.slice(cur + 1)
  let state = EditorState.create({doc, selection: {anchor: cur}, extensions: [jinja(config)]})
  let result = state.languageDataAt<CompletionSource>("autocomplete", cur)[0](new CompletionContext(state, cur, explicit))
  return result as CompletionResult | null
}

function has(result: CompletionResult | null, words: string) {
  if (!result) throw new Error("Empty result doesn't have " + words)
  for (let word of words.split(" "))
    if (!result.options.some(o => o.label == word)) throw new Error("Result doesn't have " + word)
}

describe("Jinja completion", () => {
  it("completes tags", () => {
    has(get("{% inc@"), "include if endfor")
  })

  it("completes tag after an open tag", () => {
    has(get("{% @"), "include if endfor")
  })

  it("completes filters", () => {
    has(get("{{a | grou@ }}"), "groupby")
  })

  it("completes filter after a bar", () => {
    has(get("{{a | @ }}"), "groupby")
  })

  it("completes filter in a filter statement", () => {
    has(get("{% filter @ %}"), "groupby")
  })

  it("completes expressions in a variable name", () => {
    has(get("{{ tr@ }}"), "true")
  })

  it("completes expressions in a tag", () => {
    has(get("{% if @ %}"), "none upper")
  })

  it("completes expressions in an interpolation", () => {
    has(get("{{ @ }}"), "none upper")
  })

  it("doesn't complete in comments", () => {
    ist(get("{# @ #}"), null)
  })

  it("doesn't complete in strings", () => {
    ist(get("{{ '-@-' }}"), null)
  })

  it("completes custom globals", () => {
    has(get("{{ @ }}", {variables: [{label: "custom"}]}), "custom")
  })

  it("can complete property names", () => {
    has(get("{{ a.b.c@ }}", {properties: (path) => [{label: path.join("_")}]}), "a_b")
  })
})
