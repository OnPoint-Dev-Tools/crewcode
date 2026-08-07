# Markdown Draft Retention

CrewCode keeps unsaved markdown/text editor drafts in renderer localStorage so UI refreshes, tab switches, and workspace-pane remounts do not make an open draft disappear.

Covered surfaces:

- Chat markdown editor (`MarkdownEditor`)
- Writer Workspace document editor

The chat markdown editor owns its own vertical scrollbar; the surrounding chat transcript remains fixed while editing a Markdown file.

Rules:

- Draft retention is app-local only; it does not write a file until the user saves or accepts the Writer review.
- Untitled buffers are restored by editor scope because they have no disk path yet.
- Dirty existing files restore the in-progress text instead of re-reading stale disk content.
- Saving, accepting Writer changes, or rejecting local Writer changes clears the retained draft snapshot.
- If an agent changes the active file while a local draft exists, denying the agent version preserves the retained local draft; accepting the agent version replaces and clears it explicitly.
- Converted DOCX/PDF content is retained as its Markdown working copy, never as unsaved binary data.
