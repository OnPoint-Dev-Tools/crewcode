# Agent message Markdown

Completed agent replies render GitHub-flavored Markdown. Fenced code blocks use the shared Shiki highlighter; inline code remains lightweight and is not grammar-tokenized. Headings, list markers, bold/emphasized text, links, and inline code receive restrained semantic accents derived from the active theme.

## Syntax highlighting

A fenced language identifier selects the grammar:

````md
```typescript
const ready = true
```
````

Common long-form aliases such as `typescript`, `javascript`, `shell`, `py`, and `plaintext` map to CrewCode's bundled Shiki language IDs. Unknown languages fall back to plain text. Blocks larger than 80,000 characters also remain plain to prevent large agent responses from monopolizing the renderer.

Streaming output stays plain until the turn completes, matching the existing Markdown rendering lifecycle.

## Theme integration

Shiki uses its CSS-variable theme with the `--syntax-` prefix. The canonical mappings live in `src/renderer/src/styles/colors_and_type.css` and derive from CrewCode's active semantic theme tokens, including:

- `--foreground` and `--muted-foreground`;
- `--primary` and `--crew-green-bright`;
- `--success`, `--warning`, and `--destructive`;
- `--background` and `--muted`.

Because highlighted spans and Markdown semantic classes reference CSS variables rather than fixed palette values, changing the app or editor color theme recolors existing messages without re-tokenizing them.

Semantic Markdown styling keeps body and list text on the normal foreground for readability. Accent colors are limited to structural markers and emphasized content: headings use the keyword token, list markers and bold text use the function token, emphasis uses the comment token, and inline code uses the string-expression token.

## Safety

`CodeBlock` converts Shiki tokens directly into React elements. It does not use `innerHTML`, so agent-provided code cannot inject markup through syntax highlighting. If Shiki loading or grammar resolution fails, the original code renders through the themed plain-text fallback.
