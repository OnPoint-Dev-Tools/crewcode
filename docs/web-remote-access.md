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

## Delivery stages

1. Introduce the transport-neutral client boundary and versioned protocol types. **Complete.**
2. Extract main-process IPC logic into reusable backend services. **Workspace and core filesystem operations complete; Git, PTY, and agents follow with their server transports.**
3. Add a loopback-only headless server and a minimal browser connection screen. **Core server, handshake, one-time pairing, authenticated RPC, and connection screen complete; CLI packaging remains.**
4. Add authenticated workspace/filesystem operations. **Browser adapter, pairing exchange, locally persisted device session, workspace listing, text editing, and saving complete.**
5. Add PTY and agent streaming over WebSockets. **PTY and core agent lifecycle services, authenticated event transport, browser chat/terminal controls, workspace-root enforcement, native resume IDs, local transcript fallback, compaction RPC, and permission responses complete. The full desktop shell is not mounted in browsers yet.**
6. Add pairing, session inspection/revocation, LAN endpoints, and Tailscale guidance.
7. Move the desktop application onto the same backend contract.

## CLI

```bash
npx crewcode@latest
npx crewcode serve --host 127.0.0.1
npx crewcode pair
npx crewcode auth sessions
npx crewcode auth revoke <session-id>
```

The initial CLI distribution is implemented. From a checkout, run `npm run serve`; from a published package, run `npx crewcode@latest` or `crewcode serve`. It builds/serves the shared renderer, defaults to loopback, prints a single-use pairing URL, resolves installed provider CLIs without Electron, and shuts down cleanly on SIGINT/SIGTERM. `pair` and persistent `auth` management commands remain planned.

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
