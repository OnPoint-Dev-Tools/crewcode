<!-- NOTE: README.md is generated from src/README.md -->

# @codemirror/lang-wast [![NPM version](https://img.shields.io/npm/v/@codemirror/lang-wast.svg)](https://www.npmjs.org/package/@codemirror/lang-wast)

[ [**WEBSITE**](https://codemirror.net/) | [**ISSUES**](https://code.haverbeke.berlin/codemirror/dev/issues) | [**FORUM**](https://discuss.codemirror.net/) | [**CHANGELOG**](https://code.haverbeke.berlin/codemirror/lang-wast/src/branch/main/CHANGELOG.md) ]

This package implements WebAssembly Text Format language support for
the [CodeMirror](https://codemirror.net/) code editor.

The [project page](https://codemirror.net/) has more information, a
number of [examples](https://codemirror.net/examples/) and the
[documentation](https://codemirror.net/docs/).

This code is released under an
[MIT license](https://code.haverbeke.berlin/codemirror/lang-wast/tree/main/LICENSE).

We aim to be an inclusive, welcoming community. To make that explicit,
we have a [code of
conduct](http://contributor-covenant.org/version/1/1/0/) that applies
to communication around the project.

## Usage

```javascript
import {EditorView, basicSetup} from "codemirror"
import {wast} from "@codemirror/lang-wast"

const view = new EditorView({
  parent: document.body,
  doc: `(call $log (i32.const 0) (i32.const 13))`,
  extensions: [basicSetup, wast()]
})
```

## API Reference

<dl>
<dt id="user-content-wast">
  <code><strong><a href="#user-content-wast">wast</a></strong>() → <a href="https://codemirror.net/docs/ref#language.LanguageSupport">LanguageSupport</a></code></dt>

<dd></dd>
<dt id="user-content-wastlanguage">
  <code><strong><a href="#user-content-wastlanguage">wastLanguage</a></strong>: <a href="https://codemirror.net/docs/ref#language.LRLanguage">LRLanguage</a></code></dt>

<dd></dd>
</dl>
