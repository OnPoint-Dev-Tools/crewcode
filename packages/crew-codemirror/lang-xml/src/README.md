<!-- NOTE: README.md is generated from src/README.md -->

# @codemirror/lang-xml [![NPM version](https://img.shields.io/npm/v/@codemirror/lang-xml.svg)](https://www.npmjs.org/package/@codemirror/lang-xml)

[ [**WEBSITE**](https://codemirror.net/) | [**ISSUES**](https://code.haverbeke.berlin/codemirror/dev/issues) | [**FORUM**](https://discuss.codemirror.net/c/next/) | [**CHANGELOG**](https://code.haverbeke.berlin/codemirror/lang-xml/src/branch/main/CHANGELOG.md) ]

This package implements XML language support for the
[CodeMirror](https://codemirror.net/) code editor.

The [project page](https://codemirror.net/) has more information, a
number of [examples](https://codemirror.net/examples/) and the
[documentation](https://codemirror.net/docs/).

This code is released under an
[MIT license](https://code.haverbeke.berlin/codemirror/lang-xml/tree/main/LICENSE).

We aim to be an inclusive, welcoming community. To make that explicit,
we have a [code of
conduct](http://contributor-covenant.org/version/1/1/0/) that applies
to communication around the project.

## Usage

```javascript
import {EditorView, basicSetup} from "codemirror"
import {xml} from "@codemirror/lang-xml"

const view = new EditorView({
  parent: document.body,
  doc: `<user id="22"><name>Jane</name></user>`,
  extensions: [basicSetup, xml()]
})
```

## API Reference

@xml

@xmlLanguage

@ElementSpec

@AttrSpec

@completeFromSchema

@autoCloseTags
