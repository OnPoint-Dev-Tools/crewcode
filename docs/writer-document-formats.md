# Writer document formats

Writer Workspace edits text through a Markdown working copy so every proposed change can be reviewed as a Pierre text diff before approval.

## Supported formats

| Format | Open/import | Edit | Export |
| --- | --- | --- | --- |
| Markdown (`.md`, `.mdx`) | Native | Rich or source editor | DOCX, PDF |
| Plain text (`.txt`) | Native | Source editor | DOCX, PDF |
| Word (`.docx`) | Converted to sibling Markdown | Markdown working copy | DOCX, PDF |
| PDF (`.pdf`) | Selectable text extracted to sibling Markdown | Markdown working copy | DOCX, PDF |

Selecting a DOCX or PDF in the Writer file tree creates one linked sibling Markdown file such as `chapter.writer.md`. The link is persisted in CrewCode app data, so clicking the original or a generated export reopens that same working copy instead of importing another Markdown file.

The source document is never overwritten. The first approved export creates a stable generated derivative such as `chapter.writer.docx`; later approved exports update that same derivative so Markdown changes are reflected there. CrewCode records the derivative's content hash and replaces it only while the file still matches the last CrewCode export. If another application changes the derivative, CrewCode preserves it and creates a collision-safe `chapter.writer-2.docx` instead.

## Review behavior

Local drafts and agent edits both pass through **Review Changes**:

- Local edits compare the last approved text with the current editor draft.
- Local agent file writes are detected through the editor filesystem watcher.
- SSH workspaces are polled every two seconds because remote files do not emit local filesystem events.
- Agent changes are kept as a separate review candidate, so an in-progress local draft is not silently overwritten.
- Accepting an agent version adopts the on-disk text. If a local draft also exists, the review dialog warns that acceptance replaces it.
- Denying an agent version restores the last approved text on disk. An in-progress local draft remains available.
- DOCX/PDF export is disabled until the Markdown working copy is saved and all detected changes are approved.

## Conversion limits

Conversion prioritizes editable text and review safety over layout fidelity.

- DOCX import preserves common headings, paragraphs, lists, links, and emphasis where Mammoth/Turndown can represent them as Markdown. Complex tables, Word layout, comments, tracked changes, floating objects, images, and page geometry may not round-trip.
- PDF import extracts selectable text. Scanned/image-only PDFs need OCR and currently produce a warning instead of fabricated text.
- DOCX/PDF export supports common Markdown blocks such as headings, paragraphs, lists, quotes, code, and rules. It does not reproduce the original document's exact typography or layout.
- Binary input is capped at 20 MB. Editable Markdown is capped at 2 MB so converted files remain compatible with CrewCode's normal workspace reader.

Conversion runs in CrewCode's main process with workspace-sandboxed paths. Remote files are transferred through the existing SFTP connection; CrewCode does not install or execute document tooling on the SSH host.

## Writer chat sessions

The Writer Workspace embeds a real chat pane, so its threads are ordinary chat sessions owned by the writer tab rather than by a chat tab.

- Chat sessions may be owned by any tab id in a namespace listed in `src/renderer/src/hooks/chat-session-tab-owner.ts` (`-chat` and `-writer`). A surface that embeds `ChatPane` but is not listed there is treated as an orphan by the reconciliation prune in `App.tsx` and its sessions are deleted and never listed in the workspaces drawer. Workbench panes avoid this by minting ids inside the `-chat` namespace instead.
- Writer sessions appear in the workspaces drawer and the Completed list alongside normal chats, marked with a `writer` chip so the two surfaces are not confused. Activating one focuses the Writer Workspace tab.
- Deleting or archiving a writer chat never closes the writer tab, because that tab is also the document editor. Only secondary `-chat` tabs auto-close when their last session goes.
