# Tailwind renderer compatibility

CrewCode's renderer supports Tailwind CSS v4 utilities through `@tailwindcss/vite`.

## Integration

- `electron.vite.config.ts` registers Tailwind only for the renderer build.
- `src/renderer/src/styles/tailwind.css` imports Tailwind's theme and utility layers.
- Tailwind Preflight is intentionally not imported. The existing application reset and component CSS remain authoritative, preventing an incremental Tailwind conversion from changing unrelated Electron and browser surfaces.
- Semantic Tailwind colors (`cc-canvas`, `cc-surface`, `cc-field`, `cc-hover`, `cc-ink`, `cc-muted`, `cc-line`, `cc-accent`, `cc-success`, and `cc-danger`) resolve to CrewCode's live CSS design tokens. They therefore continue to follow theme customization.

## Usage rules

Thinking-log headers use the shared outlined thought-bubble icon rather than the
generic sparkle glyph. The separate disclosure chevron continues to communicate
expand/collapse state. Turn Work Log headers pair their disclosure chevron with
the shared outlined activity-ledger icon; individual rows retain their
tool-specific icons.

Use Tailwind utilities for new or converted renderer component layout and responsive behavior. Do not hardcode a second palette or bypass the tokens in `colors_and_type.css`. Technical values and tool output remain in the configured mono font.

Legacy root class names may remain when tests or integrations use them as stable row identities. In that case, keep compatibility selectors narrow and implement the component's internal layout with utilities.

The work-log, thinking trace, and streaming-answer surfaces are the first converted components. Their existing data mapping, file-open actions, diagnostics, syntax highlighting, and diff rendering remain unchanged. Solo chat groups all reasoning segments into one Thinking log and all eligible tool calls into one Work log per turn, anchored at the first event of each kind during streaming and in restored history. Thinking starts open during an active turn; the Work log starts closed and can be opened manually. Both collapse when the turn ends and load closed in completed history. Users can manually reopen completed logs; temporary pauses in reasoning or tool activity do not reset manual disclosure. Log headers have no bottom divider. History paging retains the start of a visible turn so long turns keep their full logs. Other chat surfaces retain their existing stream-order and response-anchor layout. In solo chat, changed-file chips appear only after the turn finishes, even when individual tools have already completed; live tool rows remain available throughout the turn. The consolidated log ends with wrapping chips for every unique changed file, aggregating real add/remove counts across repeated edits. A chip opens its exact turn/file in Turn Changes and closes the agent-summary/list sidebar so the diff owns the drawer width; row-level filenames retain their editor action. Both surfaces consume the same change aggregation, including multi-file/nested provider payloads and repeated same-file edits, so their file lists cannot drift apart. Split provider output into one unified patch per file and combine repeated same-file hunks beneath one canonical header; `PierreDiff` must never receive a multi-file or multi-header patch. Responsive rules constrain long paths/output at narrow widths, and reduced-motion preferences collapse decorative transitions.

Solo agent replies render accumulated Markdown during streaming, including intermediate replies, rather than switching from plain text at completion. Headings, lists, emphasis, links, tables, and fenced code use the same Markdown renderer throughout. Incomplete syntax follows the existing Markdown parser until its closing characters arrive. Renderer component identities stay stable across updates to preserve code-block state and avoid restarting highlighting on every text delta. Completed plan replies retain their existing plan preview controls.

Solo Work logs contain independent **File changes** and **Other tools** chevron sections with tool-call counts. Only populated sections appear. Edits, writes, patches, and any tool call carrying observed file-change evidence belong to File changes; reads, searches, and other calls remain in Other tools. Order within each section follows the original turn order, and row disclosure remains tied to the source call. Both sections start open for active turns, preserve manual toggles during streaming, and close when the turn ends. Completed logs and their sections can be reopened manually. The aggregated changed-file chips still appear only after completion.
