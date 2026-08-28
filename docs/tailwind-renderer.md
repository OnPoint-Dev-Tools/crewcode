# Tailwind renderer compatibility

CrewCode's renderer supports Tailwind CSS v4 utilities through `@tailwindcss/vite`.

## Integration

- `electron.vite.config.ts` registers Tailwind only for the renderer build.
- `src/renderer/src/styles/tailwind.css` imports Tailwind's theme and utility layers.
- Tailwind Preflight is intentionally not imported. The existing application reset and component CSS remain authoritative, preventing an incremental Tailwind conversion from changing unrelated Electron and browser surfaces.
- Semantic Tailwind colors (`cc-canvas`, `cc-surface`, `cc-field`, `cc-hover`, `cc-ink`, `cc-muted`, `cc-line`, `cc-accent`, `cc-success`, and `cc-danger`) resolve to CrewCode's live CSS design tokens. They therefore continue to follow theme customization.

## Usage rules

Use Tailwind utilities for new or converted renderer component layout and responsive behavior. Do not hardcode a second palette or bypass the tokens in `colors_and_type.css`. Technical values and tool output remain in the configured mono font.

Legacy root class names may remain when tests or integrations use them as stable row identities. In that case, keep compatibility selectors narrow and implement the component's internal layout with utilities.

The work-log, thinking trace, and streaming-answer surfaces are the first converted components. Their existing data mapping, file-open actions, diagnostics, syntax highlighting, and diff rendering remain unchanged. Tool runs stay in stream order while live; when the turn has a later agent response, its earlier tool calls consolidate into one initially expanded work log directly before the latest response. The consolidated log ends with wrapping chips for every unique changed file, aggregating real add/remove counts across repeated edits. A chip opens its exact turn/file in Turn Changes and closes the agent-summary/list sidebar so the diff owns the drawer width; row-level filenames retain their editor action. Both surfaces consume the same change aggregation, including multi-file/nested provider payloads and repeated same-file edits, so their file lists cannot drift apart. Split provider output into one unified patch per file and combine repeated same-file hunks beneath one canonical header; `PierreDiff` must never receive a multi-file or multi-header patch. Responsive rules constrain long paths/output at narrow widths, and reduced-motion preferences collapse decorative transitions.
