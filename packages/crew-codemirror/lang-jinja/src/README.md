<!-- NOTE: README.md is generated from src/README.md -->

# @codemirror/lang-jinja [![NPM version](https://img.shields.io/npm/v/@codemirror/lang-jinja.svg)](https://www.npmjs.org/package/@codemirror/lang-jinja)

[ [**WEBSITE**](https://codemirror.net/) | [**ISSUES**](https://code.haverbeke.berlin/codemirror/dev/issues) | [**FORUM**](https://discuss.codemirror.net/c/next/) | [**CHANGELOG**](https://code.haverbeke.berlin/codemirror/lang-jinja/src/branch/main/CHANGELOG.md) ]

This package implements [Jinja
template](https://jinja.palletsprojects.com/en/stable/templates/)
support for the [CodeMirror](https://codemirror.net/) code editor.

The [project page](https://codemirror.net/) has more information, a
number of [examples](https://codemirror.net/examples/) and the
[documentation](https://codemirror.net/docs/).

This code is released under an
[MIT license](https://code.haverbeke.berlin/codemirror/lang-jinja/tree/main/LICENSE).

We aim to be an inclusive, welcoming community. To make that explicit,
we have a [code of
conduct](http://contributor-covenant.org/version/1/1/0/) that applies
to communication around the project.

## Usage

```javascript
import {EditorView, basicSetup} from "codemirror"
import {jinja} from "@codemirror/lang-jinja"

const view = new EditorView({
  parent: document.body,
  doc: `{% if a.active %}{{ a.title }}{% endif %}`,
  extensions: [basicSetup, jinja()]
})
```

## API Reference

@jinja

@jinjaLanguage

@JinjaCompletionConfig

@jinjaCompletionSource

@closePercentBrace
