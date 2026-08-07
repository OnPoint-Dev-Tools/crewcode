# Workbench

Workbench is a fresh workspace surface for workbench-owned chats and terminals. It opens as its own `canvas` tab internally and intentionally does **not** embed ongoing app chat or terminal tabs.

## Entry points

- Solo chat header: **Workbench** action.
- CrewCode app menu: **New Workbench**.
- Workspace drawer App tab: **Workbench**.
- Window tab `+` menu: **Workbench**.

## Current behavior

- Workbench opens empty and unassociated with active app chat sessions.
- **Add chat** creates a fresh chat pane owned by the Workbench tab.
- **Add terminal** creates a fresh terminal pane owned by the Workbench tab.
- Existing chats and terminals remain in their own app tabs and are not mounted inside Workbench.
- Workbench pane cards are persisted so app restart reopens the same Workbench chats/terminals.
- Closing a Workbench pane tears down its owned chat/terminal state.
- Closing the Workbench tab clears its owned panes.

## Persistence model

- Workbench pane layout/membership is stored in `crewcode:workbenchPanesByTab:v1`.
- Chat sessions and transcripts continue to use the existing chat session/message stores.
- Terminal pane metadata continues to use `crewcode:terminalSessions:v1` and is restored for Workbench pane IDs on launch.

## Performance guardrail

Workbench must not mount live panes from existing app tabs. Multiple active agents can stream large updates, and embedding those existing panes duplicates heavy React/xterm work that can freeze the renderer.

Workbench-owned panes are allowed because they are explicitly created inside Workbench. Future hardening should still add virtualization and terminal mount caps before encouraging high pane counts.

## Future direction

- Virtualize off-screen Workbench panes.
- Cap simultaneous mounted terminals.
- Pause or summarize hidden chat streams.
- Mount xterm only when visible/focused.
- Measure render cost under multiple active agents before enabling high pane counts.
