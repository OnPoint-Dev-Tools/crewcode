# Drag threads into split views

Drawer threads can be dragged from the selected workspace **Threads** list onto a
visible Solo Chat pane or a terminal pane. The drop uses the existing window
split group: the dropped thread opens beside the target instead of replacing it.

This is not Workbench. Workbench remains a fresh grid of workbench-owned chats
and terminals and still must not mount live app chat or terminal tabs. See
[canvas-mode.md](./canvas-mode.md).

## What you can drop

- Live drawer threads, including delegated threads
- Writer threads, which split as the Writer tab when that tab is free

Clicks still activate a thread in place. Drag is a copy into a split, not a move,
and does not delete or re-key the thread. Phone layouts disable the drag handle.

## Drop targets

| Target | Result |
| --- | --- |
| Solo Chat `.chat-pane-row` | Split that chat pane with the dropped thread |
| Embedded chat terminal column | Same split as the host chat tab, so chat and terminal stay usable together |
| Standalone terminal tab / pane | Split the terminal with the dropped thread |

Settings, Archive, Studio, Control Center, and Workbench panes are not drop
targets.

## Same-tab threads

Most threads in a workspace live on one chat tab and share a single active
session. Showing two of those threads at once cannot steal that tab's active
session from the pane you dropped onto.

In that case CrewCode opens a **session viewport** tab: `kind: 'chat'` with
`sessionOwnerTabId` plus `pinnedSessionId`. The viewport renders the dropped
session through `ChatPane` without calling `ensureTab` on the viewport id and
without changing the owner tab's active session. Transcript, bridge, and session
identity stay on the owner tab. Closing the viewport closes the extra view, not
the thread.

If the owner tab is not already visible in this split, the drop restores that
tab, activates the session there, and adds it to the split group.

Each split tab keeps its own close control. Closing one tab removes that tab
from the group and leaves the others in place. The group dissolves only when a
single pane remains. Closing a session viewport closes the extra view, not the
underlying thread.

## Limits

- Cross-workspace drops are ignored. Activate the thread's workspace first.
- A tab already used in another split group is not added to a second group;
  a viewport is used instead.
- Mobile (`≤768px`) does not offer drag. Use the existing tab-split menu or
  Workbench.
- Composer drafts on a viewport are keyed by the pinned session id so two views
  of the same owner tab do not share unsent text.
