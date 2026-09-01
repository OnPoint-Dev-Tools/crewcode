# Desktop and web continuity

CrewCode can make an enrolled machine's background Brain the authoritative runtime
for both its Electron app and Hub-connected browser clients. Files remain on the
machine; the web client operates them through that machine's Brain. This is remote
control and shared runtime state, not cloud file synchronization.

## Enable the first release

1. Enroll the machine with the self-hosted Hub as described in
   `docs/web-remote-access.md`.
2. In Electron, open **Settings → Desktop & Web** and select **Enable**.
3. Open the enrolled machine from the Hub web application. A fresh Brain has no
   file, terminal, or agent grants; missing `workspace:read` is not a failed
   tunnel.
4. In that web session open **Settings → Brain Access**, add the absolute workspace
   roots on this machine, enable `workspace:read` / `workspace:write` / `terminal` /
   `agent` as needed, then **Save and renew tunnel**. Hub identity alone never
   grants those.

**Settings → Desktop & Web** probes the enrolled Hub and displays its observed canonical
browser/passkey origin with **Open Hub**; it never treats the enrollment address as proof
of browser origin or reachability. Background Brain and Hub are separate processes:
enabling Brain does not start a standalone Hub. The default local Hub listens on
`127.0.0.1` but advertises `http://localhost:3774` as its exact browser origin, so use
`localhost` in the browser. A loopback origin works only from the Hub machine itself.

Source-checkout conveniences are `npm run enroll -- --hub <origin>`, `npm run brain`,
and `npm run hub:mobile` (Tailscale HTTPS). The foreground `npm run brain` command is
for headless/manual operation only; stop or disable Electron Background Brain before
using the same default Brain data directory.

Enabling starts a detached `crewcode brain --desktop-background` process. Electron
probes an owner-only loopback rendezvous and reloads onto the same typed RPC/event
adapter used by the browser while retaining desktop-only window, picker, updater,
clipboard, and other native integrations.

The renderer document includes a startup loading surface before React mounts. During
the enable-triggered reload it reports the Brain probe, attachment, and continuity
hydration phases, then yields to the normal workspace loading screen. This keeps the
window visibly responsive without treating a delayed probe or missing telemetry as a
successful attachment.

## Source of truth

On first enable, missing Brain runtime data is seeded from Electron `userData` into
`~/.crewcode/brain/runtime`. Existing Brain files always win and are never overwritten.
The seed includes registered workspaces, provider-native resume IDs, provider keys,
rich transcripts, and replay shards. Existing `thread:<session>` replay history also
gets a non-destructive `web:<session>` alias so the first Brain-backed prompt can
continue the desktop conversation. Provider-native resume IDs remain keyed by both
session and provider.

After attachment, the Brain store is authoritative for:

- registered, Brain-authorized workspaces;
- filesystem, Git, worktree, terminal, and agent operations routed by the shared
  client contract;
- rich visible transcripts and provider replay/resume state;
- the workspace-tab and chat-session catalogue needed to find the same threads on
  another client.

Each renderer still uses localStorage as a bounded paint/navigation cache. At startup,
it hydrates the catalogue and rich transcripts from the Brain. Four catalogue keys
(`sessionsByTab`, `activeSessionByTab`, workspace tabs, and active workspace) are
allowlisted and mirrored back as per-key patches. A client that stays open does not
pull another client's navigation changes live in this release; reload or reconnect to
discover newly created tabs/sessions. Active Brain events still stream normally.

Full-array transcript saves are merged by stable message identity on the Brain. This
prevents a stale desktop or browser save from erasing a turn already observed from the
other client. Explicit transcript removal remains the deletion mechanism.

## Concurrent prompts

Desktop and web may submit work at the same time. Stable remote bridge IDs let both
clients attach to the same Brain-owned provider execution. The Brain takes a
conversation-scoped lease:

- prompts for the same conversation run FIFO, one turn at a time;
- a queued prompt is visible through the existing follow-up events and can be removed;
- prompts in different conversations can run concurrently;
- abort, stop, bridge failure, or custody loss clears affected queued work rather than
  reporting it as completed.

Simultaneous first attachment is coalesced so two clients cannot create two provider
processes for the same stable bridge.

## Process and authority lifecycle

Closing the Electron window or quitting the ordinary desktop process does not stop an
enabled Brain. Provider processes, terminals, Hub presence, and remote access remain
available under Brain custody.

Use **Settings → Desktop & Web → Stop Brain** to disable continuity and stop the Brain,
or use **Quit and stop Brain** from the app menu to stop it and quit Electron together.
Stopping removes the owner-only rendezvous and remote machine availability. A stale
Brain cannot erase a newer process's rendezvous because removal must present the same
random control token that created it.

The local rendezvous contains separate backend-session and control tokens, is written
atomically with owner-only permissions, binds only to loopback, and never crosses the
Hub. The control endpoint only supports status, stop, and the small trusted-desktop
credential allowlist. Hub relay frames remain end-to-end encrypted and every browser
operation still passes the Brain-local scope and registered-workspace checks.
Revoked machine authority stops the Brain instead of silently reconnecting.

If a relay closes during initial browser hydration, the connection screen preserves
the first observed close reason instead of replacing it with a later generic
"not connected" error. The Hub also records the closing peer, WebSocket code, and
reason in its server-side audit store; it never records encrypted payload contents or
credentials.

Brain-to-browser encrypted frames use a bounded per-session send queue. A frame's
sequence and nonce advance only after the WebSocket accepts the preceding frame for
transmission. Serialization failure, transport rejection, or queue overflow closes
the affected tunnel explicitly instead of leaving a sequence hole that a later frame
could cross.

## First-release limits

- Only registered workspaces inside the Brain's authorized local roots appear. The
  setting does not copy files to the Hub or another machine.
- `ssh://` workspaces are not exposed through this local Brain route yet; operate them
  from the desktop's existing SSH runtime.
- Newly changed navigation/catalogue state appears on another already-open client
  after reload/reconnect, not as live tab switching.
- Custom desktop agent-path overrides do not configure the detached Brain; its
  headless provider resolver uses the Brain process environment.
- Local voice sidecars and remaining desktop-only orchestration surfaces stay owned by
  Electron. They are not promised as web-continuous in this release.
- Crash-durable restoration of an in-flight provider process remains out of scope. A
  Brain restart may resume persisted conversation state, but unobserved in-flight work
  is interrupted, never inferred successful.

## Implementation map

- `src/main/brain-desktop-service.ts` — Electron lifecycle, seed, probe, RPC, events.
- `src/main/brain-desktop-rendezvous.ts` — owner-only connection/preferences files.
- `src/main/hub-machine-enrollment.ts` and `src/main/hub-brain-relay.ts` — detached
  Brain startup, local backend lifetime, Hub relay, revocation handling.
- `src/renderer/src/runtime/web-rpc-client.ts` — composite Brain-attached Electron
  client.
- `src/main/continuity-state-service.ts` and
  `src/renderer/src/runtime/continuity-state.ts` — bounded catalogue continuity.
- `src/main/agents/bridge-service.ts` — stable-start coalescing and per-conversation
  prompt serialization.
- `src/main/transcript-service.ts` — concurrent full-transcript merge.
