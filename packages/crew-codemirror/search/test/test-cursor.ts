import {SearchCursor, RegExpCursor} from "@codemirror/search"
import {Text} from "@codemirror/state"
import ist from "ist"

function testMatches(cursor: SearchCursor | RegExpCursor, expected: ([number, number] | [number, number, boolean])[]) {
  let matches = []
  while (!cursor.next().done) matches.push([cursor.value.from, cursor.value.to, cursor.value.precise])
  ist(JSON.stringify(matches), JSON.stringify(expected.map(m => m.length == 2 ? [m[0], m[1], true] : m)))
}

describe("SearchCursor", () => {
  it("finds all matches in a simple string", () => {
    testMatches(new SearchCursor(Text.of(["one two one two one"]), "one"),
                [[0, 3], [8, 11], [16, 19]])
  })

  it("finds only matches in the given region", () => {
    testMatches(new SearchCursor(Text.of(["one two one two one"]), "one", 2, 17),
                [[8, 11]])
  })

  it("can cross lines", () => {
    testMatches(new SearchCursor(Text.of(["one two", "one two", "one"]), "one"),
                [[0, 3], [8, 11], [16, 19]])
  })

  it("can normalize case", () => {
    testMatches(new SearchCursor(Text.of(["ONE two oNe two one"]), "one", 0, 19, s => s.toLowerCase()),
                [[0, 3], [8, 11], [16, 19]])
  })

  it("doesn't get confused by expanding transforms", () => {
    testMatches(new SearchCursor(Text.of(["Auf die Straße"]), "straße", 0, 14, s => s.toUpperCase()),
                [[8, 14]])
  })

  it("normalizes composed chars", () => {
    testMatches(new SearchCursor(Text.of(["héé"]), "héé"), // First one is composed, second decomposed
                [[0, 3]])
    testMatches(new SearchCursor(Text.of(["héé"]), "héé"), // First one is decomposed, second composed
                [[0, 5]])
  })

  it("can match across lines", () => {
    testMatches(new SearchCursor(Text.of(["one two", "three four"]), "two\nthree"),
                [[4, 13]])
  })

  it("can search an empty document", () => {
    testMatches(new SearchCursor(Text.empty, "aaaa"), [])
  })

  it("doesn't include overlapping results", () => {
    testMatches(new SearchCursor(Text.of(["fofofofo"]), "fofo"), [[0, 4], [4, 8]])
  })

  it("includes overlapping results with nextOverlapping", () => {
    let cursor = new SearchCursor(Text.of(["fofofofo"]), "fofo")
    let matches = []
    while (!cursor.nextOverlapping().done) matches.push([cursor.value.from, cursor.value.to])
    ist(JSON.stringify(matches), "[[0,4],[2,6],[4,8]]")
  })

  it("will mark matched partial normalized content as imprecise", () => {
    testMatches(new SearchCursor(Text.of(["´"]), " "), [[0, 1, false]])
  })

  it("produces the correct range for astral chars that get normalized to non-astral", () => {
    testMatches(new SearchCursor(Text.of(["𝜎"]), "𝜎"), [[0, 2]])
  })

  it("can handle normalizers that remove text", () => {
    testMatches(new SearchCursor(Text.of(["hello"]), "halal", 0, 5, s => s.replace(/[aeuoi]/g, "")), [[0, 4]])
  })

  it("matches full compatibility-character expansions", () => {
    // [5, 6] is the single source character "㌢", normalized to "センチ".
    testMatches(new SearchCursor(Text.of(["高さ180㌢の棚"]), "センチ"), [[5, 6, true]])
  })

  it("matches prefixes inside compatibility-character expansions", () => {
    // [5, 6] is the single source character "㌢", normalized to "センチ".
    testMatches(new SearchCursor(Text.of(["高さ180㌢の棚"]), "セン"), [[5, 6, false]])
  })

  it("matches suffixes inside compatibility-character expansions", () => {
    // [5, 6] is the single source character "㌢", normalized to "センチ".
    testMatches(new SearchCursor(Text.of(["高さ180㌢の棚"]), "ンチ"), [[5, 6, false]])
  })

  it("matches characters completely inside compatibility-character expansions", () => {
    testMatches(new SearchCursor(Text.of(["高さ180㌢の棚"]), "ン"), [[5, 6, false]])
  })

  it("matches across compatibility-character expansion boundaries", () => {
    // [5, 7] covers the source characters "㌢㍍", normalized to "センチメートル".
    testMatches(new SearchCursor(Text.of(["高さ180㌢㍍の棚"]), "チメ"), [[5, 7, false]])
  })
})

describe("RegExpCursor", () => {
  it("finds all matches in a simple string", () => {
    testMatches(new RegExpCursor(Text.of(["one two one two one"]), "one"),
                [[0, 3], [8, 11], [16, 19]])
  })

  it("matches by-line", () => {
    testMatches(new RegExpCursor(Text.of(["one two", "three four five", "six"]), "^\\w+|\\w+$"),
                [[0, 3], [4, 7], [8, 13], [19, 23], [24, 27]])
  })

  it("handles empty lines", () => {
    testMatches(new RegExpCursor(Text.of(["one", "", "two"]), ".*"),
                [[0, 3], [4, 4], [5, 8]])
  })

  it("handles empty documents", () => {
    testMatches(new RegExpCursor(Text.empty, ".*"), [[0, 0]])
    testMatches(new RegExpCursor(Text.empty, "okay"), [])
  })

  it("properly cuts off long matches", () => {
    testMatches(new RegExpCursor(Text.of(["abcdefghi"]), ".*", {}, 3, 6), [[3, 6]])
  })

  it("can match case-insensitively", () => {
    testMatches(new RegExpCursor(Text.of(["abcdefghi"]), "DEF", {ignoreCase: true}), [[3, 6]])
  })

  it("matches across lines", () => {
    testMatches(new RegExpCursor(Text.of(["abc", "def"]), "c\nd"), [[2, 5]])
  })

  it("detects multi-line regexps", () => {
    testMatches(new RegExpCursor(Text.of(["abc", "def"]), "c\\sd"), [[2, 5]])
    testMatches(new RegExpCursor(Text.of(["abc", "def"]), "c\\Wd"), [[2, 5]])
    testMatches(new RegExpCursor(Text.of(["abc", "def"]), "c\\Dd"), [[2, 5]])
    testMatches(new RegExpCursor(Text.of(["abc", "def"]), "c[^x]d"), [[2, 5]])
  })

  it("can match a large document", () => {
    let line = "1234567890".repeat(10)
    let doc = Text.of(new Array(100).fill(line))
    let cur = new RegExpCursor(doc, "[^]*").next()
    ist(!cur.done)
    ist(cur.value.from, 0)
    ist(cur.value.to, doc.length)
    ist(cur.value.match[0].length, doc.length)
  })

  it("will match line starts properly in multiline mode", () => {
    testMatches(new RegExpCursor(Text.of(["x", "a1111", "111a1111"]), "^a(1|\\s)*"), [[2, 11]])
  })

  it("will match line ends properly in multiline mode", () => {
    testMatches(new RegExpCursor(Text.of(["x", "111p111", "1111p"]), "(1|\\s)*p$"), [[6, 15]])
  })
})
