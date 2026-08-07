<!-- NOTE: README.md is generated from src/README.md -->

# @codemirror/lang-less [![NPM version](https://img.shields.io/npm/v/@codemirror/lang-less.svg)](https://www.npmjs.org/package/@codemirror/lang-less)

[ [**WEBSITE**](https://codemirror.net/) | [**ISSUES**](https://code.haverbeke.berlin/codemirror/dev/issues) | [**FORUM**](https://discuss.codemirror.net/c/next/) | [**CHANGELOG**](https://code.haverbeke.berlin/codemirror/lang-less/src/branch/main/CHANGELOG.md) ]

This package implements Less language support for the
[CodeMirror](https://codemirror.net/) code editor.

The [project page](https://codemirror.net/) has more information, a
number of [examples](https://codemirror.net/examples/) and the
[documentation](https://codemirror.net/docs/).

This code is released under an
[MIT license](https://code.haverbeke.berlin/codemirror/lang-less/tree/main/LICENSE).

We aim to be an inclusive, welcoming community. To make that explicit,
we have a [code of
conduct](http://contributor-covenant.org/version/1/1/0/) that applies
to communication around the project.

## Usage

```javascript
import {EditorView, basicSetup} from "codemirror"
import {less} from "@codemirror/lang-less"

const view = new EditorView({
  parent: document.body,
  doc: `#header { width: @width }`,
  extensions: [basicSetup, less()]
})
```

## API Reference

@less

@lessLanguage

@lessCompletionSource
