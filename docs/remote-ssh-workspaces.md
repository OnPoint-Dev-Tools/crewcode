# Remote SSH workspaces

CrewCode can open a project that lives on another machine over SSH. The file
tree, editor, git surfaces, terminals, and agents all operate on the remote
host — the workspace behaves like a local one, with the differences noted
below.

## Adding a remote project

1. Workspace drawer → **Add project** → **Remote project** ("ssh connected
   target").
2. Enter a host — either a raw `user@host[:port]` or an alias from your
   `~/.ssh/config` (CrewCode lists your config hosts as suggestions).
3. Connect, then browse the remote filesystem starting from the remote home
   directory and pick the project folder.

The workspace root is stored as an `ssh://` URI:

```txt
ssh://[user@]host[:port]/absolute/posix/path
e.g. ssh://cj@build-box:22/home/cj/projects/api
```

## SSH connections in Settings

**Settings → SSH** manages saved connections:

- Add a connection (name + address), **test** it, or remove it.
- Hosts from `~/.ssh/config` are imported automatically and listed alongside
  saved connections; **open config** jumps to the file.
- Saved connections and config aliases both appear as targets when adding a
  remote project.

## Authentication

- **SSH agent first.** If an agent socket is available, CrewCode authenticates
  through it — this transparently handles passphrase-protected keys. The SSH
  Keys modal can load keys into the agent for you.
- **Identity files as fallback.** Without an agent, CrewCode reads the
  `IdentityFile` from your SSH config (or the default `~/.ssh` keys).
  Encrypted keys need the agent path.

### Host key pinning (trust-on-first-use)

The first host key seen for a server is pinned to
`~/.crewcode/known-hosts.json`. If the key later changes, CrewCode **refuses
the connection** (possible MITM or server rekey).

> [!WARNING]
> If a host legitimately rekeyed, remove its entry from
> `~/.crewcode/known-hosts.json` to re-trust it on the next connection.

## What works remotely

| Area | Behavior |
| --- | --- |
| File tree / editor | SFTP-backed reads and writes |
| Git | git runs on the remote host (remote credentials/agent apply) |
| Terminals | remote shell sessions |
| Agents | agent CLIs run on the remote host |
| Code intelligence | the TypeScript language server is launched **on the remote**; the remote host must have `typescript` and `typescript-language-server` installed — CrewCode does not install them |
| Writer file watching | bounded polling (remote filesystem events are unavailable) |

CrewCode advertises ACP text-file methods for both local and remote CrewCoder
sessions. Remote custody is negotiated separately through explicit initialize
metadata; the presence of file methods alone does not disable provider-native
tools or reject providers in an ordinary local chat.

## Limitations

- Plugins are denied access to remote workspaces (plugin API v0 is local-only).
- Commit signing passphrase handling is local-repo only for now.
- Connections are pooled and shared across workspaces on the same host; a slow
  or dropped link affects all of that host's workspaces until it reconnects.
