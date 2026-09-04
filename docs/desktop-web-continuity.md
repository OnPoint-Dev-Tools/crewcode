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

The Hub-connected web application also exposes **Settings → Hub Machines**. It lists
all machines enrolled to the signed-in Hub owner, not only the currently selected
machine. Disabling a row immediately suspends that machine's Hub credential, closes
its relay/browser sessions, and blocks new tickets and heartbeats while preserving
the enrollment for a later Enable. If the current machine is disabled, the Brain
tunnel disconnects but the same-origin Hub control plane remains available so the
owner can enable it again. The machine stays offline until its Brain reconnects and
the Hub observes a fresh heartbeat.

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

The browser adapter keeps unconditional desktop event subscriptions safe by returning
an inert disposer when their native event source does not exist. Optional desktop-only
capabilities remain genuinely absent so shared feature probes do not render or invoke
native-only controls such as system-tray configuration. Unsupported user actions may
still return an explicit error, but startup and React effect cleanup must never receive
a rejected Promise where they require a disposer function.

## Source of truth

On first enable, missing Brain runtime data is seeded from Electron `userData` into
`~/.crewcode/brain/runtime`. Existing Brain files always win for workspaces, keys, and
replay; they are never overwritten. Transcript shards are merged instead: a newer
desktop copy is folded into the Brain shard by message identity so work done locally
before attachment is not stuck on the first seed snapshot. The seed includes
registered workspaces, provider-native resume IDs, provider keys, rich transcripts,
and replay shards. Existing `thread:<session>` replay history also
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
it hydrates the catalogue plus bounded recent tails for active and locally cached
conversation scopes from the Brain. A cold conversation hydrates its own bounded tail
when opened. Each remote scope tail is capped at 96 KiB; the 32-scope startup window
therefore stays below 3 MiB of transcript plaintext and leaves encryption and other
startup RPCs headroom inside the Hub's shared 8 MiB relay burst. Full shards remain
authoritative on the Brain. The renderer never requests `transcripts.loadAll` over the
Brain/Hub relay: combining a large transcript store into one encrypted frame can exceed both
the relay frame limit and the JavaScript string limit. Full per-scope shards remain
authoritative on the Brain and incoming full-array saves merge into those shards.
Five catalogue keys
(`sessionsByTab`, `activeSessionByTab`, workspace tabs, active workspace, and
session completion timestamps for drawer elapsed labels) are
allowlisted and mirrored back as per-key patches. A client that stays open does not
pull another client's navigation changes live in this release; reload or reconnect to
discover newly created tabs/sessions. Active Brain events still stream normally.

On attachment, Electron writes the exact desktop workspace-tab and chat-session
catalogue — names, active selection, tab-key order, and per-tab session order — through
an owner-loopback desktop-control call. The Brain persists an internal desktop-catalogue
authority marker with that payload. Generic browser `continuity.update` cannot create
that marker. Until the marker exists, or while the Brain still contains
transcript-derived recovered rows, matching desktop rows replace Brain copies instead of
losing to them. Unmatched recovered navigation rows are dropped while their full
transcript shards remain, and genuine web-created rows are appended so detached browser
work is not lost. After authority is established and recovered rows are gone, an
existing Brain identity wins rather than being replaced by a stale desktop copy.

Once the marker is present, web clients render that exact catalogue and do not
synthesize additional transcript-derived drawer rows. Reload or reconnect the browser
after desktop attachment to pick up the seeded names and order; this release does not
push another client's navigation changes live. This marker is specific to optional
Electron-to-Brain attachment: standalone Hub, `hub --local-brain`, manually started
Brain, and web-only deployments retain their existing catalogue/recovery behavior and
do not require a desktop.

If a catalogue is incomplete, the Brain returns a bounded
metadata-only transcript catalogue (scope id, timestamp, secret-free provider/model
hints, and a four-word `titleHint` from the first user prompt). The renderer
reconstructs missing solo-chat rows for registered workspaces without transferring
transcript bodies, provider-native resume ids, or unrelated crew lane scopes.
Recovered rows are stored oldest-first, matching desktop `sessionsByTab` order: the
canonical workspace chat first, then extra chat tabs by their id timestamp, with
sessions inside a tab in creation order. The workspace drawer sorts own threads by
that same tab-id timestamp so newest chats stay on top even when a recovered
catalogue was saved newest-first. They use that title hint instead of a dated
Recovered chat label. Those rows are browser-local fallback
navigation and are not written back through the allowlisted continuity update.
Legacy Brain rows that still have dated Recovered chat labels are retitled from the
same hint. Sending work from a fallback row promotes that exact row to an ordinary
Brain-owned session; merely viewing, sorting, or renaming a recovered row does not let
synthetic metadata replace the desktop drawer catalogue.

Provider availability and model discovery come from the detached Brain environment.
Browser startup never attempts to apply Electron executable-path overrides before
reading that registry. Headless provider detection checks normal PATH, common install
locations (including Bun cache installs), and login/interactive shell resolution; its
automatic registry refresh uses asynchronous filesystem and child-process probes.
`agents.listModels` uses the same CLI/server detectors as desktop for every
installed provider, not only Ollama. Empty discovery still keeps the renderer
catalog visible.

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
Reversible Hub disablement is different: it withdraws remote authority and closes
Hub tunnels, but a running local/background Brain retains local custody and retries
the outbound relay. Re-enabling does not assert that the Brain is online; only its
subsequent observed connection and heartbeat do. Permanent revocation still stops
the Brain and requires re-enrollment.

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

Browser delegation enable/disable/respond RPC belongs to the existing Brain-local
`agent` scope. Delegation endpoints and bearer credentials remain bound to the owning
authenticated browser session; cleanup denial or relay loss is contained and never
reported as a successful revocation.

## First-release limits

- Only registered workspaces inside the Brain's authorized local roots appear. The
  setting does not copy files to the Hub or another machine.
- `ssh://` workspaces are not exposed through this local Brain route yet; operate them
  from the desktop's existing SSH runtime.
- Newly changed navigation/catalogue state appears on another already-open client
  after reload/reconnect, not as live tab switching.
- Browser and newly attached desktop clients hydrate the recent bounded tail of an
  opened conversation. Paging older history from its full Brain shard is not included
  in this first release.
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
- `src/main/hub-store.ts` and `src/main/hub-server.ts` — owner-scoped machine
  enable/disable state, CSRF-protected mutations, and relay containment.
- `src/renderer/src/runtime/web-rpc-client.ts` — composite Brain-attached Electron
  client plus authenticated Hub control-plane adapter for Hub web Settings.
- `src/main/continuity-state-service.ts` and
  `src/renderer/src/runtime/continuity-state.ts` — bounded catalogue continuity.
- `src/main/agents/bridge-service.ts` — stable-start coalescing and per-conversation
  prompt serialization.
- `src/main/transcript-service.ts` — concurrent full-transcript merge and bounded
  per-scope relay hydration.
