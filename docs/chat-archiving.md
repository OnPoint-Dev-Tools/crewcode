# Chat Archiving

Archiving parks a chat session out of sight without destroying it. It is the
non-destructive counterpart to Delete: the session record, its settings, and its
full on-disk transcript all survive.

## Where it lives

- **Right-click any chat row** in the Workspaces drawer/sidebar →
  `Rename chat` / `Archive chat` / `Delete chat`.
- Archived chats do NOT appear in the drawer — they are hidden from every live
  surface. The **Archive page** (App menu → Archive) is the one place to see
  them: a single cross-workspace list with search, a workspace filter, per-row
  Restore/Delete, and the retention control.

## Retention

`settings.archiveRetentionDays` is `0 | 30 | 60 | 90`, default `0` ("Never").
It is set from the Archive page header.

**Retention never deletes anything.** It is a classifier, not a scheduler:
chats past the window are flagged `expired` in the list and summarized in a
banner offering one explicit, confirmed bulk delete. There is no background
sweep, no timer, and no code path that removes a transcript without a click.
Deleting chat history irreversibly is not something an app should do on a clock.

The clock is `Session.archivedAt`, stamped when a chat is archived and cleared
on restore (so a re-archive gets a full window). Two deliberate safety rules:

- **A session with no `archivedAt` is never expired.** Its real archive date is
  unknowable, so it must never land behind a "Delete all" button.
- **Legacy archived sessions are backfilled to "first launch after upgrade"**
  (`backfillArchivedAt`), not to zero. Turning on a 30-day policy can't
  retroactively flag history that was archived at an unknown time.
- A corrupt/unknown persisted retention value falls back to `Never`, never to a
  window.

## Behavior contract

`Session.archived?: boolean` is the whole state. It is persisted with the rest
of the session in `crewcode:sessionsByTab`.

- **Archiving releases the session's bridge** (`releaseScope(id, { stopRunning: true })`).
  Archiving a running agent stops that turn — this is deliberate: archiving is
  also how you free an idle agent's memory.
- **Transcripts are never deleted on archive.** No `transcripts:remove`, no
  `messagesByTab` purge. Only explicit Delete drops the on-disk transcript.
- **Archived sessions are invisible to every derived surface.** `getSessions()`
  returns live sessions only, so the drawer list, completed chats, chat recency,
  workspace/session agent status, and Mission Control all skip them
  automatically. `getAllSessions()` is the only accessor that returns archived
  rows, and only the archive list uses it.
- **Activation never lands on an archived session.** `getActiveId` /
  `getActiveSession` fall back to the first *live* session. Archiving the active
  session activates the next live one.
- **A fully-archived tab behaves like an empty tab.** `ensureTab` seeds a fresh
  thread when a tab has no live sessions, so archiving your last chat leaves you
  on a new blank one rather than stranded on an archived thread. The new session
  id is chosen to skip ids already taken by archived sessions — reusing an id
  would alias two threads onto one transcript file.
- **Archiving the last live session of a *secondary* chat tab closes that tab.**
  The workspace's canonical `<wsId>-chat` tab stays open and gets a fresh thread.
- **Restoring rehydrates the tab** (`restoreChatTabInWorkspace`) before
  activating, because the tab may have been closed on archive.
- **Delete rules:** a tab's last *live* session still cannot be deleted (the
  caller uses that refusal to close the now-empty tab). Archived sessions carry
  no such constraint and are always deletable, and deleting from the archive
  does not yank the user into that chat's tab.

## Files

| File | Role |
| --- | --- |
| `src/renderer/src/types/index.ts` | `Session.archived`, `Session.archivedAt`, `archive` tab kind |
| `src/renderer/src/hooks/useChatSessions.ts` | `setArchived`, `backfillArchivedAt`, live-only accessors, id allocation |
| `src/renderer/src/hooks/archive-retention.ts` | pure expiry/age rules |
| `src/renderer/src/hooks/useSettings.tsx` | `archiveRetentionDays` + its fail-safe normalization |
| `src/renderer/src/App.tsx` | `archiveSession` / `restoreSession` / `renameSession`, live vs archived grouping, page wiring |
| `src/renderer/src/components/archive/ArchivePage.tsx` | the cross-workspace archive page |
| `src/renderer/src/components/workspaces/WorkspacesDrawer.tsx` | live-row right-click menu (Rename / Archive / Delete) |
| `src/renderer/src/components/thread/Sessions.tsx` | row context-menu hook, `archived` variant |

Covered by `src/renderer/src/hooks/useChatSessions.test.ts` and
`src/renderer/src/hooks/archive-retention.test.ts`.
