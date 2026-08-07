import {EditorState} from "@codemirror/state"
import {CompletionContext, CompletionResult} from "@codemirror/autocomplete"
import {goLanguage, localCompletionSource} from "@codemirror/lang-go"
import ist from "ist"

function get(doc: string, conf: {explicit?: boolean} = {}) {
  let cur = doc.indexOf("|")
  doc = doc.slice(0, cur) + doc.slice(cur + 1)
  let state = EditorState.create({
    doc,
    selection: {anchor: cur},
    extensions: [goLanguage]
  })
  let result = localCompletionSource(new CompletionContext(state, cur, !!conf.explicit)) as CompletionResult | null
  return result ? result.options.map(o => o.label).sort().join(" ") : ""
}

function getExp(doc: string) {
  return get(doc, {explicit: true})
}

describe("Go local completion", () => {
  it("doesn't complete from nothing unless explicit", () =>
    ist(!get("var x = 1\n|")))

  it("completes locals", () =>
    ist(getExp("var x = 1\n|"), "x"))

  it("completes locals defined in a list", () =>
    ist(getExp(`var (x = 1; y = 2)\n|`), "x y"))

  it("completes locals defined as a set", () =>
    ist(getExp(`var a, b = 1, 2\n|`), "a b"))

  it("completes constants", () =>
    ist(get(`const (a = 1; b = 2)\na|`), "a b"))

  it("completes shorthand variables", () =>
    ist(get(`a, b := 1, 2\na|`), "a b"))

  it("completes function names", () =>
    ist(get(`func a() {}\na|`), "a"))

  it("doesn't complete method names", () =>
    ist(get(`func(T) a() {}\na|`), ""))

  it("completes arguments", () =>
    ist(get(`func foo(a, b int, c T) {\n  a|\n}`), "a b c foo"))

  it("completes imports", () =>
    ist(get(`import a "p1"\nimport (b "p2"; c "p3")\na|`), "a b c"))

  it("completes type names", () =>
    ist(get(`type a = T\ntype (b U; c V)\na|`), "a b c"))

  it("completes from outer scopes", () =>
    ist(get(`var x = 1\nfunc y(z nil) {\na|\n}`), "x y z"))

  it("doesn't complete from inner or sibling scopes", () =>
    ist(get(`func f(j int) {\n  var u = 2\n}{\n  {\n    var q = 3\n  }\na|\n}`), "f"))

})
