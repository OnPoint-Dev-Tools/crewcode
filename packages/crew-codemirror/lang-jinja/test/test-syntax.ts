import {jinjaLanguage} from "@codemirror/lang-jinja"
import {fileTests} from "@lezer/generator/dist/test"

// @ts-ignore
import * as fs from "node:fs"
// @ts-ignore
import * as path from "node:path"
let caseDir = (import.meta as any).dirname

for (let file of fs.readdirSync(caseDir)) {
  if (!/\.txt$/.test(file)) continue
  let name = /^[^\.]*/.exec(file)![0]
  describe(name, () => {
    for (let {name, run} of fileTests(fs.readFileSync(path.join(caseDir, file), "utf8"), file))
      it(name, () => run(jinjaLanguage.parser))
  })
}
