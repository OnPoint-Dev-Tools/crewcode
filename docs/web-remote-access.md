# Web remote access

CrewCode is moving toward a headless server that can be controlled by the same
React application used by the Electron desktop app.

## Architecture contract

The renderer must access privileged features through the typed CrewCode client
contract. Components and hooks must not add new transport-specific HTTP,
WebSocket, or Electron IPC calls.

```text
shared React renderer
  -> Electron client -> Electron IPC -> backend services
  -> Web client      -> authenticated HTTP/WebSocket -> backend services
```

Filesystem, Git, PTY, agent, SSH, plugin, and credential operations remain on
the server. Provider keys and other permanent secrets must never be returned to
a browser client.

The network protocol starts at version 1. Request/response envelopes and server
capabilities live in `src/shared/remote-access-types.ts`. Browser startup
negotiates a compatible protocol, exchanges a URL-fragment pairing credential,
removes that credential from browser history, validates the resulting device
session, and only then installs the privileged client adapter.

## Security baseline

- Bind to loopback by default.
- Require an explicit host option for LAN or private-network exposure.
- Never expose Electron IPC handlers directly as an unauthenticated network API.
- Use short-lived, single-use pairing tokens.
- Exchange pairing tokens for revocable device sessions.
- Validate request payloads and workspace paths server-side.
- Use HTTP for bounded RPC and WebSockets for PTY/agent/event streams.
- Enforce origin checks, request-size limits, rate limits, and session expiry.
- Recommend Tailscale or another trusted private network for access between devices.

### Current direct-server security status

Pairing credentials remain memory-only, short-lived, and single-use. Device sessions
are persisted as SHA-256 digests in an owner-only atomic store, survive restarts,
expire after 30 days or 7 idle days, and can be listed/revoked through authenticated
RPC. HTTP and WebSocket browser requests enforce exact same-origin checks, with
repeatable `--public-origin` exceptions for explicitly configured reverse proxies.
Pairing and invalid-session attempts have bounded per-peer fixed-window limits.

User-facing `crewcode auth` commands, general authenticated-RPC traffic limits, and
turnkey LAN/Tailscale deployment guidance remain incomplete. Keep the server on
loopback or a trusted private network unless its proxy, TLS, and public origin are
configured deliberately.

## Connection modes

CrewCode supports two distinct deployment modes. They must share the typed client
contract, but must not share credentials or silently fall back from one trust model
to the other.

### Direct mode (implemented preview)

The brain serves the React application and API itself. A browser opens a one-time
pairing URL, exchanges it for a brain-local session, and talks directly to that
brain. This mode is for loopback, LAN, or a trusted tailnet. It requires a reachable
address and does not provide account login or machine discovery.

### Self-hosted Hub mode (identity foundation implemented)

The first Hub slice is implemented as the separate `crewcode hub` process. It
provides durable local identity storage, first-owner passkey bootstrap, passkey
sign-in, revocable browser sessions, audit events, and an authenticated machine-list
skeleton. Machine enrollment, outbound brain presence, connection tickets, relay,
end-to-end browser-to-brain encryption, and the shared renderer adapter remain
planned; the current Hub cannot remotely control a brain yet.

A user runs one always-on **CrewCode Hub** on a Linux desktop, headless server,
NAS, or other trusted host. The Hub serves the React application, local sign-in,
machine registry, and relay. Every CrewCode brain makes an **outbound-only**
persistent connection to that Hub, so enrolled machines can appear in one dashboard
without opening a separate inbound port for every machine.

The Hub URL is deployment-specific. CJ's personal deployment uses
`https://crewcode.logixhub.icu`; this is not a CrewCode-operated SaaS endpoint and
must never be hardcoded as the application default. Other users provide their own
LAN address, Tailscale HTTPS name, or user-controlled domain when configuring their
Hub and enrolling brains.

```text
browser
  -> HTTPS local sign-in + machine list -> self-hosted CrewCode Hub
  -> authenticated encrypted tunnel     -> Hub relay <- outbound tunnel <- CrewCode brain

Hub control plane: local users, machine keys, enrollment, presence, revocation
Hub relay:         connection routing, backpressure, short-lived ticket enforcement
brain:             final authorization, workspace sandbox, RPC execution, secrets
```

The Hub relay is not a replacement for the brain's authorization boundary. The
brain must validate the user, machine audience, expiry, and session identity on
every new tunnel before installing a privileged client session.

A managed CrewCode-hosted Hub may be added later, but it must implement the same
protocol and must never be required for self-hosted operation.

## Self-hosted Hub identity and relay contract

### Local sign-in and bootstrap

- First launch creates no default password. It prints a short-lived, single-use
  owner setup URL whose credential remains memory-only. The first owner registers
  a user-verifying passkey. Recovery codes are still planned and must be implemented
  before passkeys are presented as recoverable.
- Subsequent browser sessions authenticate to the Hub with WebAuthn/passkeys. An
  optional external OIDC provider may be configured by the Hub owner, but is not
  required.
- The browser uses secure, HttpOnly, SameSite cookies for the Hub session; Hub bearer
  tokens must not be stored in `localStorage`.
- State-changing Hub routes require CSRF protection and exact checks against the
  configured public origin. The Hub refuses ambiguous forwarded-host/protocol
  headers unless the reverse proxy is explicitly trusted.
- Recovery must not silently restore access to revoked machines. Recovering Hub
  ownership and trusting a machine are separate events.

The first release may be single-owner, but authorization must still use stable local
user ids so multi-user access can be added without changing machine identity.

### Machine enrollment

1. `crewcode enroll --hub <url>` creates or loads a machine identity key and prints
   a short-lived device authorization URL/code. Use an OS keystore or TPM when
   available, with an owner-only file fallback for headless systems.
2. The user signs in to their Hub, confirms the machine name and fingerprint, and
   assigns the machine to an allowed local user.
3. The brain exchanges the approved device code for a revocable machine credential.
   Only a digest/encrypted form is persisted, with owner-only filesystem permissions.
4. The Hub stores the machine public key, owner, display name, created time,
   last-seen time, and revocation state. It never receives provider keys, workspace
   credentials, source files, transcripts, or terminal output as control-plane data.
5. Re-enrollment and ownership transfer require explicit confirmation. A revoked
   machine credential cannot be refreshed.

Enrollment codes are single-use, short-lived, rate-limited, and bound to the machine
key. A copied code alone must not be enough to impersonate a machine.

### Presence and discovery

An enrolled brain opens an outbound `wss://` connection to its configured Hub,
proves possession of its machine key with a Hub nonce, and sends a bounded
capability/presence record. The machine list exposes only metadata such as:

- stable opaque machine id and user-selected name;
- online, offline, connecting, or revoked status;
- platform, CrewCode version, protocol version, and coarse capabilities;
- last seen time and an optional user-selected location label.

Workspace paths, repository names, active prompts, and provider identities are not
presence metadata. Presence expires when heartbeats stop; silence is `offline`,
never evidence that a command or agent turn completed.

### Browser connection

1. The signed-in browser selects a machine.
2. The Hub issues a very short-lived, single-use connection ticket bound to the
   local user, browser session, machine id, requested protocol, and random nonce.
3. The browser and brain connect through the Hub relay. The brain validates the
   signed ticket and rejects expired, replayed, revoked, wrong-audience, or
   unauthorized-user tickets.
4. The browser and brain perform an authenticated end-to-end handshake using the
   enrolled machine public key and a browser ephemeral key before privileged RPC is
   enabled.
5. HTTP-style RPC and PTY/agent events are multiplexed as bounded tunnel frames. The
   existing versioned request/response envelopes remain the application protocol.
6. Disconnecting marks in-flight outcomes `interrupted` unless the brain observed
   and persisted a terminal result. Reconnect never infers success from silence.

The Hub adapter belongs behind `crewcode-client.ts`. Components and hooks must not
know whether frames use direct HTTP/WebSocket or the Hub relay.

### Network deployment

The Hub binds to loopback by default and requires explicit network configuration.
Supported deployment profiles are:

- **LAN:** bind the Hub to a private interface and use trusted local DNS/TLS. Access
  works only from that network.
- **Tailnet (recommended):** keep the Hub private and publish HTTPS through
  Tailscale. Browsers and brains join the tailnet; no public ingress is required.
- **User-controlled public origin:** use the owner's own domain and place Caddy,
  nginx, or another HTTPS reverse proxy in front of the Hub. For example, CJ uses
  `https://crewcode.logixhub.icu` for his deployment. The owner is responsible for
  DNS, firewall configuration, and TLS renewal.
- **Reverse tunnel:** keep the Hub local and publish a user-controlled domain through
  Cloudflare Tunnel or an equivalent service. This makes the service internet
  reachable, and that provider becomes part of the network threat model.

CrewCode must not automatically enable public exposure, edit firewall rules, or
create a third-party tunnel. Setup should print explicit commands and warnings for
the profile selected by the owner.

### Relay privacy and limits

TLS protects each network hop, but hop-by-hop TLS alone lets a reverse proxy, tunnel
provider, or Hub relay inspect source and terminal traffic. Application-layer
end-to-end encryption between browser and brain is required for public/reverse-tunnel
deployments and should be used in every profile; the relay routes opaque frames.
Metadata needed for abuse prevention (local user id, machine id, connection id,
frame size, timestamps, and close reason) may be logged with an owner-configurable
retention period.

The relay must enforce per-user/machine connection limits, frame-size limits, idle
and absolute connection expiry, bandwidth backpressure, replay protection, and rate
limits before forwarding traffic. It must never accept arbitrary destination hosts
or become a general-purpose TCP proxy.

### Revocation and custody

- Owners can inspect and revoke browser sessions, users, and enrolled machines from
  the Hub.
- A brain periodically revalidates machine status and immediately closes new and
  active tunnels when revocation is observed.
- If identity, scope, relay continuity, or session authority becomes unknown, the
  brain refuses new privileged actions and applies the execution-custody rules in
  `docs/execution-custody.md`.
- Relay loss does not kill an agent blindly if doing so could corrupt work, but the
  run must be contained, recorded as interrupted/unknown where its result was not
  observed, and require the documented reauthorization path.
- Audit events record bootstrap, enrollment, connection, rejection, revocation, and
  authority changes. They must not include prompts, source content, provider secrets,
  or raw terminal streams.

## Hub service boundary

The Hub runs as a separate headless process rather than inside the Electron renderer
or main process. It may ship from this repository as `crewcode hub`, but its storage
and network lifecycle remain independent from any one brain. This repository owns
the shared protocol, Hub service, brain connector, CLI enrollment flow, and browser
adapter. No identity, proxy, or database vendor SDK may leak into renderer components
or backend workspace services.

Minimum Hub data model:

```text
LocalUser(id, credential, role, created_at, revoked_at)
Machine(id, owner_user_id, public_key, name, status, created_at, last_seen_at, revoked_at)
BrowserSession(id, user_id, created_at, expires_at, revoked_at)
ConnectionTicket(id, user_id, machine_id, browser_session_id, expires_at, used_at)
AuditEvent(id, user_id?, machine_id?, browser_session_id?, type, created_at, metadata)
```

## Delivery stages

1. Introduce the transport-neutral client boundary and versioned protocol types. **Complete.**
2. Extract main-process IPC logic into reusable backend services. **Workspace and core filesystem operations complete; Git, PTY, and agents follow with their server transports.**
3. Add a loopback-only headless server and a minimal browser connection screen. **Core server, handshake, one-time pairing, authenticated RPC, and connection screen complete; CLI packaging remains.**
4. Add authenticated workspace/filesystem operations. **Browser adapter, pairing exchange, locally persisted device session, workspace listing, text editing, and saving complete.**
5. Add PTY and agent streaming over WebSockets. **PTY and core agent lifecycle services, authenticated event transport, browser chat/terminal controls, workspace-root enforcement, native resume IDs, local transcript fallback, compaction RPC, and permission responses complete. The full desktop shell is not mounted in browsers yet.**
6. Harden direct mode: persistent expiring sessions, authenticated
   inspection/revocation RPC, exact origin checks, and authentication rate limits
   are **complete**. User-facing auth CLI commands, general request-rate policy, and
   LAN/Tailscale guidance remain.
7. Implement the self-hosted `crewcode hub` process, local owner bootstrap,
   passkey sessions, machine registry, audit events, and signed single-use tickets.
   **Process/CLI, SQLite identity schema, passkey bootstrap/sign-in, browser sessions,
   audit storage, and machine registry are complete. Recovery and signed connection
   tickets remain.**
8. Implement `crewcode enroll`, persistent machine identity, outbound presence, and
   explicit machine revocation. **Enrollment, owner-only machine credentials,
   outbound heartbeat presence, dashboard status, and revocation are complete.
   Machine logout/credential rotation remain.**
9. Implement the bounded Hub relay and a transport-neutral multiplexed tunnel with
   authenticated end-to-end browser-to-brain encryption.
10. Replace the direct-only browser connection screen with local Hub sign-in,
    machine list/status, machine selection, reconnect, and revocation UI while
    retaining an explicit direct-pairing route.
11. Persist remote execution custody and test disconnect, restart, revocation,
    replay, cross-user isolation, relay compromise, and backpressure behavior.
12. Move the desktop application onto the same backend contract.

## CLI

Implemented direct-server commands:

```bash
npx crewcode@latest
npx crewcode serve --host 127.0.0.1
npx crewcode serve --host 0.0.0.0 --public-origin https://your-hub.example
```

Implemented self-hosted Hub command:

```bash
crewcode hub
crewcode hub --host 0.0.0.0 --public-origin https://your-hub.example
```

The Hub defaults to `127.0.0.1:3774`, stores state in `~/.crewcode/hub/hub.sqlite`,
and prints a ten-minute single-use owner setup URL on first launch. Interactive
terminals receive an OSC 8 clickable setup link plus the raw URL as a copy fallback.
Browsers normally treat `http://localhost` as a secure context, but some Linux
browser/passkey-provider combinations reject it with `InsecureLocalhostNotAllowed`;
use a current Chrome/Chromium build for local testing or the final HTTPS Hub origin.
Do not weaken the Hub CSP for extension-injected scripts or styles. Wildcard binds
require an explicit final public origin; non-loopback origins require HTTPS because
the origin is cryptographically bound to passkeys. Put a TLS reverse proxy or
Tailscale HTTPS in front of the HTTP listener for network deployment.

After signing in, select **Enroll a machine**. The Hub issues a memory-only,
ten-minute, single-use token. On that machine run the displayed command and paste
the token at the hidden prompt:

```bash
crewcode enroll --hub https://your-hub.example
crewcode brain
```

Enrollment creates an Ed25519 machine identity plus a random bearer credential in
`~/.crewcode/brain/hub-machine.json`, written with owner-only permissions. The Hub
stores the public key and only a SHA-256 digest of the bearer secret. `crewcode brain`
then makes outbound HTTPS heartbeat requests every 30 seconds; the dashboard marks a
machine offline after 90 seconds without a successful heartbeat. Revoking it in the
dashboard immediately rejects later heartbeats. Enrollment tokens are never written
to the Hub database and are invalidated by Hub restart, expiry, first successful use,
or a failed guess against their id.

This presence process does **not** accept commands, expose workspaces, start agents,
or establish a relay. The Ed25519 key is reserved for the later signed-ticket and
encrypted-relay stages; current heartbeat authentication uses the separate random
machine bearer credential over HTTPS.

Planned direct-auth and remaining Hub commands:

```bash
crewcode pair
crewcode auth sessions
crewcode auth revoke <session-id>
crewcode hub machines
crewcode hub revoke <machine-id>
crewcode brain logout
```

The initial CLI distribution is implemented. From a checkout, run `npm run serve`;
from a published package, run `npx crewcode@latest` or `crewcode serve`. It
builds/serves the shared renderer, defaults to loopback, prints a single-use pairing
URL, resolves installed provider CLIs without Electron, and shuts down cleanly on
SIGINT/SIGTERM. The direct-auth CLI and remaining machine-management/relay commands above remain
planned. Enrollment and dashboard revocation are implemented. `crewcode hub` has its
own standalone setup/sign-in/machine-list screen; it does not yet mount the shared
CrewCode workspace client.

## Current backend extraction

`WorkspaceService` owns persisted workspace listing and mutations, project
creation, cloning, and remote workspace registration without importing Electron.
`FilesystemService` owns sandboxed directory listing, text reads/writes, and file
discovery, including the existing SSH routing. Network filesystem RPC also
rejects roots absent from the server workspace store, preventing a browser from
substituting `/` or another arbitrary host path. `workspaceStore.ts` and `fs.ts`
are now Electron transport adapters for those operations. Native folder pickers,
attachment handling, formatting, and destructive filesystem mutations remain in
the Electron adapter until their browser API and validation contracts are added.

`PtyService` now owns process lifecycle independently of Electron. Both Electron
IPC and the remote server adapt that service. Browser terminal creation is
restricted to registered workspace roots, commands use authenticated HTTP RPC,
and output/exit events use an authenticated WebSocket endpoint. Core agent bridge start/prompt/abort/stop/mode and permission-response operations
now use `AgentBridgeService`, with normalized events delivered on the authenticated
WebSocket. The server resolves binaries and API keys itself and discards browser-
supplied secrets, environment variables, external directory grants, and plugin
providers. The reusable service now persists provider resume IDs and normalized local
user/assistant transcript fallback, and exposes provider compaction. Complex
cross-provider handoff summaries and every desktop-only surface still live in the
Electron application; browser chat intentionally uses the same bridge contract
without pretending unsupported desktop controls are available.
