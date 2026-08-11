# CrewCode Security Model

> Status: living document. It traces the exact authority chain a security reviewer
> raised — `untrusted content -> agent -> MCP/plugin -> exec -> Git/SSH` — and for
> each hop states the boundary, where it is enforced, and the test that guards it.
> It also states residual risk plainly. "Runs locally" is **not** treated as
> equivalent to "safely bounded."

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

# Full security-relevant suite (112 tests)
npx vitest run src/main/security-boundary-proof.test.ts \
               src/main/security-config.test.ts \
               src/main/plugin-contract.test.ts \
               src/main/plugin-git-install.test.ts \
               src/main/remote-access-server.test.ts \
               src/main/agents/codex-bridge.test.ts

# Live checks in the running app (DevTools console):
#   main window:  require            -> ReferenceError
#   plugin iframe: window.electronAPI -> undefined
```

## Residual risk (stated plainly)

Split into what has been **hardened** and what is **inherent** (true of every tool in
this class — the honest move is to frame it, not fake a patch).

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

### Inherent (cannot be "fixed" by anyone — framed honestly)

4. **Prompt injection at hop 1.** Mitigated by downstream gates, not eliminated. An agent
   can still be socially engineered into *proposing* bad actions; the defense is that
   *acting* on them requires clearing the hop 3/4 gates above. No agent tool on the market
   eliminates this; claiming otherwise is a red flag.
5. **User-enabled Full Access — now backstopped by a hard tripwire.** `full` mode
   deliberately removes the per-action gate; it is a user opt-in, never the default
   (default is `build`, pinned by test). On top of that, a **hard denylist tripwire**
   (`agents/dangerous-command.ts`) forces a confirmation prompt for catastrophic shell
   commands *even in Full Access* — `rm -rf`, `git push --force`, `curl|sh`, `dd`/`mkfs`,
   `sudo`, fork bombs, `chmod -R 777 /`, `terraform destroy`, etc. Benign commands stay
   friction-free (verified it does not flag `npm install`, `git push`, `chmod +x`, ...).
   This directly limits the compound risk of prompt-injection (#4) + Full Access.

   **Per-agent coverage (stated honestly):**
   - **Claude** — full coverage. Full Access routes through `canUseTool` (no more native
     `bypassPermissions`), so every command is classified; denylisted ones pause. Highest
     priority because Claude's Full Access is an unsandboxed shell.
   - **CrewCoder(ACP), Hermes(ACP)** — covered via the tool call's `rawInput`; denylisted
     commands fall through to a confirmation prompt instead of auto-approving.
   - **Codex** — **not yet routed through the tripwire**, but Full Access still runs under a
     `workspace-write` sandbox (writes scoped to the workspace, network off), so its blast
     radius is already the smallest. Tracked as follow-up.
   - **Grok, pi** — **not yet covered**; their Full Access uses engine-native bypass / a
     confirmation channel that does not carry the command string. Tracked as follow-up.
   - **Ollama, OpenRouter** — N/A (no tool surface; cannot exec).
6. **MCP servers run with user privilege.** A user-configured MCP server is trusted code on
   the host; CrewCode gates *which* sessions may use it, not what the server binary itself
   can do — the same trust model as installing any CLI tool.

## What "complete" means here

Every gate we can enumerate is proven to deny by an executable test, and every privileged
path from untrusted code is mapped to a gate above. That is the achievable definition of
"completely tested." It is **not** a mathematical proof that no bypass exists anywhere —
no test suite provides that. The residual-risk section is where we keep that honest.
