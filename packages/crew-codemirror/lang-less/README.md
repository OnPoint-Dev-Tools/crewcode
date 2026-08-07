<!-- NOTE: README.md is generated from src/README.md -->

# @codemirror/lang-less [![NPM version](https://img.shields.io/npm/v/@codemirror/lang-less.svg)](https://www.npmjs.org/package/@codemirror/lang-less)

[ [**WEBSITE**](https://codemirror.net/) | [**ISSUES**](https://code.haverbeke.berlin/codemirror/dev/issues) | [**FORUM**](https://discuss.codemirror.net/) | [**CHANGELOG**](https://code.haverbeke.berlin/codemirror/lang-less/src/branch/main/CHANGELOG.md) ]

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

<dl>
<dt id="user-content-less">
  <code><strong><a href="#user-content-less">less</a></strong>() → <a href="https://codemirror.net/docs/ref#language.LanguageSupport">LanguageSupport</a></code></dt>

<dd><p>Language support for Less.</p>
</dd>
<dt id="user-content-lesslanguage">
  <code><strong><a href="#user-content-lesslanguage">lessLanguage</a></strong>: <a href="https://codemirror.net/docs/ref#language.LRLanguage">LRLanguage</a></code></dt>

<dd><p>A language provider for Less style sheets.</p>
</dd>
<dt id="user-content-lesscompletionsource">
  <code><strong><a href="#user-content-lesscompletionsource">lessCompletionSource</a></strong>: <a href="https://codemirror.net/docs/ref#autocomplete.CompletionSource">CompletionSource</a></code></dt>

<dd><p>Property, variable, @-variable, and value keyword completion
source.</p>
</dd>
</dl>
