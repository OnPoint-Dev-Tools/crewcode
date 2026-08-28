# CrewCode Security Model

> Status: living document. It traces the exact authority chain a security reviewer
> raised — `untrusted content -> agent -> MCP/plugin -> exec -> Git/SSH` — and for
> each hop states the boundary, where it is enforced, and the test that guards it.
> It also states residual risk plainly. "Runs locally" is **not** treated as
> equivalent to "safely bounded."
>
> This document covers **granting** authority. Its companion,
> [`execution-custody.md`](execution-custody.md), covers **withdrawing** it once
> granted — the tripwire, halt, and reauthorization lifecycle.

## Threat model in one picture

CrewCode has three trust tiers. The whole model rests on keeping them apart:

| Tier | Who | What it can reach |
| --- | --- | --- |
| **Trusted renderer** | CrewCode's own React app | All ~165 `ipcMain` handlers, via `contextBridge` (`window.electronAPI`) |
| **Untrusted plugin UI** | third-party plugin code | A sandboxed iframe with **no** `electronAPI`; reaches the main process through exactly **two** postMessage channels (see below) |
| **Untrusted content** | scraped pages, file contents, MCP tool output, agent responses | Enters the system as **data**, not as an authority holder |

Key principle the reviewer named: **same visibility ≠ same instruction authority.**
Content an agent can *see* does not inherit the agent's power to *act*. Authority is
re-decided at each hop's gate, not carried forward as context.

## Electron process boundary

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox` defaults preserved
  (`src/main/index.ts:138`). Verify in the running app: DevTools console `require`
  throws `ReferenceError`.
- The renderer receives a typed `contextBridge` surface only (`src/preload/index.ts:55`),
  never raw Node or `ipcRenderer`.
- Production renderer CSP locks `default-src 'self'`, `connect-src 'self' data: blob:`
  (`src/main/index.ts:89`), so a compromised renderer cannot open arbitrary sockets.

## Remote browser -> headless brain boundary

**Boundary:** a network browser must not acquire privileged RPC authority through a
replayed pairing link, stolen persisted file, cross-origin request, or unbounded
credential guessing.

**Enforcement:** `RemoteAccessAuth` keeps pairing credentials memory-only,
short-lived, and single-use. Device session files contain SHA-256 digests rather than
bearer tokens, are written atomically with owner-only permissions, survive restart,
and enforce 30-day absolute plus 7-day idle expiry. Authenticated `auth.sessions` and
`auth.revoke` RPC expose only sanitized metadata. HTTP and WebSocket browser requests
must match the request's exact origin or a CLI-configured `--public-origin`.
Pairing and failed-session attempts use bounded per-peer fixed-window limits. The
brain still revalidates registered workspace roots for filesystem, Git, PTY, and
agent operations; transport authentication does not widen filesystem scope.

**Tests:** `remote-access-auth.test.ts`, `remote-access-security.test.ts`, and
`remote-access-server.test.ts` cover persistence/restart, expiry, revocation,
corrupt-store refusal, origin rejection, rate limiting, and workspace denial.

**Residual limitation:** the direct server does not yet have a general
per-authenticated-session RPC bandwidth/request budget, remote execution custody is
not fully persisted, and public deployment still depends on correctly configured
TLS/reverse-proxy infrastructure. Prefer loopback or a trusted tailnet.

## Hub owner -> enrolled machine boundary

**Boundary:** signing into the Hub must not silently enroll a machine or grant remote
execution. A stolen/replayed enrollment link, database disclosure, cross-site
request, or revoked machine credential must not produce lasting machine presence.

**Enforcement:** only a valid owner browser session plus its rotated CSRF secret can
issue an enrollment token. Tokens contain 256 bits of random secret, live only in
Hub memory, expire after ten minutes, are single-use, and are consumed after a failed
secret presentation for a known id. Issuance/enrollment requests are bounded by a
per-peer limiter. Enrollment creates an Ed25519 identity on the brain and a separate
256-bit bearer credential; the brain stores both in an owner-only atomic file while
the Hub stores the public key and only SHA-256 of the bearer secret. Heartbeats are
outbound HTTPS requests. Presence goes offline after 90 seconds without a successful
heartbeat, and owner revocation immediately makes the bearer credential fail closed.
Browser mutations retain exact-origin and CSRF enforcement. The explicitly labeled
first-owner QR carries the same short-lived, single-use bootstrap fragment already
printed to the trusted terminal; it expires in ten minutes and is removed after
registration. Normal mobile QR codes encode only the stable validated HTTPS Hub
origin and are rendered in the authenticated dashboard; they contain no browser
session, enrollment secret, or Brain ticket. Phone-approved enrollment keeps its
Ed25519 private key on the PC, uses the short code only for human comparison, and
protects polling/credential delivery with a separate 256-bit request secret. Pending
requests are memory-only, bounded, rate-limited, ten-minute, owner-approved with
CSRF, one-time on delivery, and audited.
Tailscale setup refuses to overwrite an existing Serve configuration without an
explicit replacement flag. QR transfer does not weaken normal passkey sign-in.

**Connection and execution gates:** only an authenticated Hub browser session plus
CSRF can issue a 60-second memory-only ticket for one owned, active, relay-connected
machine. Ticket ids are one-shot even after a wrong-secret guess. The authenticated
outbound Brain WebSocket and exact-origin browser WebSocket are paired only for that
machine; the relay bounds frame size and buffered output, applies a shared per-connection
token bucket (240-frame/8 MiB burst, refilling at 60 frames and 2 MiB per second),
and never accepts arbitrary destinations. Browser and Brain then use ephemeral P-256 ECDH. The Brain signs the
handshake transcript with its enrolled Ed25519 key, and ordered application frames
use direction-separated HKDF/AES-256-GCM keys. The Hub sees routing metadata and
handshake public values, but not RPC, source, terminal, prompt, or response plaintext.

Hub identity still does not grant execution. `crewcode hub --local-brain` enrolls
the Hub host only after the owner passkey exists, then spawns a sibling Brain;
it does not skip Brain-local scope checks or write workspace roots into Hub SQLite.
The first `crewcode brain` start grants
no RPC scope by default and seeds an owner-only persisted policy from explicit local
`--workspace-root` and repeatable `--allow-scope` settings. Thereafter Settings →
Brain Access manages it only through E2EE owner RPC. Reductions apply immediately,
stop affected agents/terminals, and remove scopes from existing sessions; additions
require a fresh ticket and handshake. Each decrypted method must be included in both
the ticket request and current local grant. The backend revalidates live workspace
roots for filesystem, Git, PTY, attachments, and agent calls.

**Tests:** `hub-server.test.ts` covers CSRF, issue/enroll, local-brain owner gating,
replay rejection, stale
presence, heartbeat, and revocation. `hub-local-brain.test.ts` covers sibling spawn
plans, loopback origin matching, credential reuse, and supervisor stop. `hub-machine-enrollment.test.ts` covers URL
policy, argument-secret avoidance, credential validation, owner-only file mode, and
Brain CLI grants. `hub-relay.test.ts` covers ticket expiry/one-shot behavior,
authenticated relay routing, Ed25519-authenticated E2EE, scoped read success, local
scope denial, per-connection traffic rejection, and ticket replay rejection.
`hub-relay-client.test.ts` covers explicit fresh-ticket reconnect without RPC replay.

**Residual limitation:** machine credential rotation/logout and recovery are not yet
implemented. Relay traffic is bounded per connection, but durable bandwidth metrics
and broader aggregate abuse accounting are not implemented. Browser relay loss now
detaches Brain-owned terminals and agents instead of stopping them. A fresh encrypted
connection can explicitly reclaim stable resource ids, with up to 100 owned resources
per user and 1,000 events / 1 MiB of detached evidence buffered per resource;
interrupted RPCs are never replayed.
Execution custody is still process-resident rather than crash durable: Brain process,
VPS, revocation, or persistent Brain-to-Hub relay loss can stop execution without a
complete remote halt journal. Attachments are tunneled as ordered chunks inside the
E2EE relay: Hub receives ciphertext only, while Brain enforces `workspace:write`, a
25 MiB file limit, registered-root and symlink containment, strict sequence and
size bounds, SHA-256 integrity, active-upload limits, and temporary-file cleanup.

## Hop 1 — untrusted content -> agent

**Boundary:** injected instructions in scraped/file/MCP content must not gain
execution authority.

**Enforcement:** this is defense-in-depth, **not** content trust classification.
CrewCode does not (and cannot reliably) tag content as "trusted." Instead the
*downstream* hops each re-gate. An injected "run `git push --force`" only matters
if it clears the exec gate at hop 4.

**Honest note:** prompt injection can influence what an agent *says* or *attempts*.
That is true of every agent tool today. Our guarantee is about what it can *do*
without passing a gate, not about immunity to being influenced.

## Hop 2 — agent -> MCP/plugin

**Boundary:** a plugin gets exactly the authority its manifest declared — no more —
and cannot reach the privileged IPC surface directly.

**Enforcement:**
- Plugin UI runs in a sandboxed iframe (`allow-scripts allow-same-origin allow-forms`),
  loaded over `crewcode-plugin://` (never `file://`), with `referrerPolicy: no-referrer`
  (`PluginTabHost.tsx`). It never receives `window.electronAPI` (verify: iframe console
  `window.electronAPI` is `undefined`).
- The iframe's **only** path to the main process is two host-mediated channels:
  `plugins:invoke` (permission-gated) and `plugins:recordRuntimeError` (logs a string).
  The host hardcodes `registrationId` and `workspaceRoot`; the plugin cannot spoof its
  identity or target another workspace.
- Every capability is checked against the declared permission set in
  `invokePluginCapabilityWithPlugins` (`plugin-contract.ts`). Undeclared capability =>
  denied. `network:fetch` and `secrets:get` are denied outright in v0.
- Workspace file access is path-scoped by `isSafePathUnder`; `../` escape => denied,
  even with the permission granted.

**Tests:** `security-boundary-proof.test.ts` (group C), `plugin-contract.test.ts`.

## Hop 3 — MCP/plugin -> exec

**Boundary:** read/plan modes cannot silently execute; write access is an explicit,
per-request or opt-in decision, never a default that untrusted input can flip.

**Enforcement (per agent, because each bridge differs):**
- **Codex** — `getModeConfig`: plan/ask => `sandbox: read-only` + `approvalPolicy:
  untrusted`; `codexApprovalDecisionForMode` auto-declines. `full` is the only
  auto-accept, and an explicit `read-only` tool policy overrides even `full`.
- **Claude** — `getClaudeModeOptions`: plan/ask/read-only put `Bash, Edit, MultiEdit,
  Write, NotebookEdit` (+ `ExitPlanMode` in plan) in `disallowedTools`; the SDK never
  invokes them. `bypassPermissions` is reachable only via explicit `full` mode. Runtime
  approvals route through `canUseTool` (`claude-bridge.ts:510`).

**Tests:** `security-boundary-proof.test.ts` (group D), `codex-bridge.test.ts`.

## Hop 4 — exec -> Git/SSH

**Boundary:** remote trust is pinned, external launches are allowlisted.

**Enforcement:**
- SSH host keys are TOFU-pinned in `~/.crewcode/known-hosts.json` (0600). A changed
  key fails the handshake (`makeHostVerifier`, `remote/host-keys.ts`).
- `shell.openExternal` accepts only `http:`/`https:`/`mailto:` (`index.ts:577`);
  `setWindowOpenHandler` applies the same allowlist.
- Plugin capabilities are denied entirely on remote (`ssh://`) workspaces in v0.

**Tests:** `security-boundary-proof.test.ts` (group E), `remote-access-server.test.ts`.

## Hop 5 — after the gate: withdrawing authority that was already granted

**Boundary:** a grant stops being valid the moment CrewCode can no longer say
what it covers. Hops 1–4 decide whether authority may cross the *next* boundary;
they are stateless and only run when something asks. Agent runs are long-lived,
so the dangerous state is not "the attacker got in" — it is *the system no longer
knows whether its previously granted authority is still lawful, and continued
anyway.*

**Enforcement:** a persisted custody record per bridge execution, and a tripwire
that refuses, contains, preserves, reports, and requires explicit human
reauthorization. Five invariants: `restart-recovery`, `execution-custody-lost`,
`authority-drift`, `scope-unknown`, `orphaned-authorization`.

The governing rule, binding on all new work via `AGENTS.md`:

```
silence != success · timeout != success · lost telemetry != success
missing process state != success · clean Git state != behavioral correctness
```

An outcome that was never observed is recorded as unknown. It is never
back-filled by inference. A mode change requested underneath a running turn is
refused and deferred to the next turn rather than applied mid-flight.

**Coverage, stated honestly:** the desktop bridge coordinator is fully covered.
The remote-access transport defers mid-turn mode changes and cancels orphaned
permission requests, but does not yet persist custody records. Terminal panes,
plugin capability sessions, and mid-session SSH host-key changes are **not yet
covered**. Crew merges have their own equivalent journal.

**Tests:** `security-boundary-proof.test.ts` (group F), `custody-invariants.test.ts`,
`custody-journal.test.ts`, `custody.test.ts`. Full detail:
[`execution-custody.md`](execution-custody.md).

## Supply chain / plugin install

- Install is Git-first, pinned to a reviewed commit. The installer runs **no** build
  scripts, hooks, or package installs (no `child_process` in `plugins.ts`).
- Symlinks, submodules, `node_modules`, and oversized trees are rejected.
- Updates come only from the recorded repo, back up the prior folder, and re-require
  approval for every new revision even when permissions are unchanged.
- Provider credentials live in `userData` (0600), are never in source, and are not
  exposed to plugins without a `secrets:read` route (which is denied in v0).

**Tests:** `plugin-git-install.test.ts`.

## How to verify (run these yourself)

```bash
# Boundary proofs: plugin authority, exec gates (all 6 bridges), iframe sandbox, SSH TOFU
npx vitest run src/main/security-boundary-proof.test.ts

# Renderer-boundary regression guards: CSP, isolation flags, external-URL allowlist
npx vitest run src/main/security-config.test.ts

# Execution custody: invariant detection, journal recovery, halt/reauthorize
npx vitest run src/main/agents/custody-invariants.test.ts \
               src/main/agents/custody-journal.test.ts \
               src/main/agents/custody.test.ts

# Full security-relevant suite
npx vitest run src/main/security-boundary-proof.test.ts \
               src/main/security-config.test.ts \
               src/main/plugin-contract.test.ts \
               src/main/plugin-git-install.test.ts \
               src/main/remote-access-server.test.ts \
               src/main/agents/codex-bridge.test.ts \
               src/main/agents/custody-invariants.test.ts \
               src/main/agents/custody-journal.test.ts \
               src/main/agents/custody.test.ts

# Live checks in the running app (DevTools console):
#   main window:  require            -> ReferenceError
#   plugin iframe: window.electronAPI -> undefined
```

## Residual risk (stated plainly)

Split into what has been **hardened** and what is **inherent** (true of every tool in
this class — the honest move is to frame it, not fake a patch).

**A caution about the word "inherent."** A failure mode can be inherent to a
component without its *consequence* being inherent to the system. Prompt injection
inherently influences an agent; an MCP server inherently runs with user privilege.
That bounds what those components can be trusted to do — it does not license
CrewCode to keep executing once one of those risks stops being hypothetical. Hop 5
above exists because of exactly that distinction: the items below describe what
cannot be prevented, not what cannot be *contained after the fact*.

### Hardened (regression-guarded so it cannot silently weaken)

1. **Renderer authority boundary.** CSP, `contextIsolation`/`nodeIntegration`, and the
   external-URL launch allowlist now live in one pure module (`security-config.ts`) and
   are pinned by `security-config.test.ts` (CSP has no `unsafe-eval`/wildcard, `object-src`
   /`base-uri` are `'none'`, `connect-src` stays off the open internet, only http/https/
   mailto launch externally). This does **not** make renderer script-execution impossible
   — a dependency compromise remains the real risk — but it forecloses accidental loosening.
2. **Plugin iframe isolation.** Each plugin loads from `crewcode-plugin://<pluginId>`, a
   distinct standard-scheme origin — cross-origin to the app renderer *and to every other
   plugin*. `allow-same-origin` grants the frame only its own origin (for asset loading);
   it cannot reach `parent`. The sandbox token set is pinned by test so it can't gain
   `allow-top-navigation`/`allow-popups`/`allow-modals`. Verified live: iframe
   `window.electronAPI` is `undefined`.
3. **Exec gate across ALL six agent bridges.** Previously only Codex/Claude were proven.
   Now OpenCode, Hermes, pi, Grok, CrewCoder(ACP), and Claude/Codex each have a boundary
   test that read-only/ask/plan block writes and that `full`/bypass is reachable only by
   explicit opt-in. Ollama and OpenRouter expose **no** tool surface at all (pure chat
   streamers), so they cannot write or exec regardless of mode.
4. **Crew-lane authority can be withdrawn after it was granted.** Previously CrewCode
   could only deny the *next* action; a grant already in flight was good until the lane
   ended, and an execution whose outcome was never observed left no trace. For synthetic
   crew lane bridge threads, a persisted custody journal records execution, an interrupted
   turn is recovered as halted rather than assumed complete, mid-turn authority mutations
   are refused and deferred, and a tripped invariant refuses privileged actions until a
   human explicitly reauthorizes — reporting the exact failed invariant and affected
   scope, with the interrupted prompt and partial response preserved. Ordinary solo chats
   and crew supervisors deliberately retain normal provider error/retry behavior. See hop 5 and
   [`execution-custody.md`](execution-custody.md). Coverage gaps (remote transport, PTY,
   plugin sessions) are named there rather than implied away.

### Inherent (cannot be "fixed" by anyone — framed honestly)

5. **Prompt injection at hop 1.** Mitigated by downstream gates, not eliminated. An agent
   can still be socially engineered into *proposing* bad actions; the defense is that
   *acting* on them requires clearing the hop 3/4 gates above. No agent tool on the market
   eliminates this; claiming otherwise is a red flag. What is *not* inherent is continuing
   afterwards: if an injected action leaves execution in a state CrewCode can no longer
   account for, hop 5 halts the thread rather than carrying the grant forward.
6. **User-enabled Full Access — now backstopped by a hard tripwire.** `full` mode
   deliberately removes the per-action gate; it is a user opt-in, never the default
   (default is `build`, pinned by test). On top of that, a **hard denylist tripwire**
   (`agents/dangerous-command.ts`) forces a confirmation prompt for catastrophic shell
   commands *even in Full Access* — `rm -rf`, `git push --force`, `curl|sh`, `dd`/`mkfs`,
   `sudo`, fork bombs, `chmod -R 777 /`, `terraform destroy`, etc. Benign commands stay
   friction-free (verified it does not flag `npm install`, `git push`, `chmod +x`, ...).
   This directly limits the compound risk of prompt-injection (#5) + Full Access.

   **Per-agent coverage (stated honestly):**
   - **Claude** — full coverage. Full Access routes through `canUseTool` (no more native
     `bypassPermissions`), so every command is classified; denylisted ones pause. Highest
     priority because Claude's Full Access is an unsandboxed shell.
   - **Grok** — full coverage. Full Access now routes through `session/request_permission`
     (`--permission-mode default` instead of `bypassPermissions`); benign commands
     auto-approve, denylisted ones pause. Also an unsandboxed shell, so high priority.
   - **CrewCoder(ACP), Hermes(ACP)** — covered via the tool call's `rawInput`; denylisted
     commands fall through to a confirmation prompt instead of auto-approving.
   - **Codex** — defense-in-depth tripwire wired into its approval handler, AND Full Access
     runs under a `workspace-write` sandbox (writes scoped to the workspace, network off).
     The sandbox alone already blocks most of the denylist (`curl|sh`, force-push, `dd`,
     `mkfs`, `sudo`, `chmod /` all need network or out-of-workspace access it denies); the
     only residual is destroying files *inside* the workspace, which is git-recoverable.
   - **pi** — **not covered.** pi's protocol has no pre-execution permission request that
     carries the command string (its `confirm` channel omits it, and `tool_execution_start`
     is informational — it cannot block). A tripwire here needs a pi protocol change; a
     best-effort hook would be false confidence, so it is deliberately omitted and tracked.
   - **Ollama, OpenRouter** — N/A (no tool surface; cannot exec).
7. **MCP servers run with user privilege.** A user-configured MCP server is trusted code on
   the host; CrewCode gates *which* sessions may use it, not what the server binary itself
   can do — the same trust model as installing any CLI tool. What CrewCode does control is
   its own record of which servers a live grant covers: an MCP server appearing or
   disappearing under a running execution is `authority-drift` and halts the thread.

## What "complete" means here

Every gate we can enumerate is proven to deny by an executable test, and every privileged
path from untrusted code is mapped to a gate above. That is the achievable definition of
"completely tested." It is **not** a mathematical proof that no bypass exists anywhere —
no test suite provides that. The residual-risk section is where we keep that honest.
