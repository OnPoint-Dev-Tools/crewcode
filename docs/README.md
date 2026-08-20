# CrewCode documentation

Index for the docs site. Only the **Docs site** sections below get published;
everything under **Developer docs** stays repo-only (QA guides, design specs,
internal references).

## Docs site — Using CrewCode

### Getting around

| Doc | What it covers |
| --- | --- |
| [getting-started.md](./getting-started.md) | Install from a release or source, providers, first run |
| [arch-linux-package.md](./arch-linux-package.md) | Build, upgrade, and uninstall the temporary manual Arch Linux package |
| [keybindings.md](./keybindings.md) | Every shortcut, defaults per group, and the editable `~/.crewcode/keys.json` override file |
| [tweaks-panel.md](./tweaks-panel.md) | The floating Layout panel: density and workspace dock presentation controls |
| [system-monitor.md](./system-monitor.md) | CPU/memory pill and panel: per-workspace process usage, jump-to and kill controls |

### Chat and agents

| Doc | What it covers |
| --- | --- |
| [using-crews.md](./using-crews.md) | Crews: parallel lanes, supervisors, and the select → verify → reconcile → apply Merge lanes workflow |
| [reasoning-effort.md](./reasoning-effort.md) | Provider-native reasoning effort levels in the composer and crew lanes |
| [realtime-voice.md](./realtime-voice.md) | Voice orb providers, coding-agent routing, natural spoken replies, credentials, and local roadmap |
| [prompt-skill-studio.md](./prompt-skill-studio.md) | Prompt Builder Studio and local `.crewcode` prompt/skill folders _(needs a user-guide rewrite — currently changelog-style)_ |

### Workspaces

| Doc | What it covers |
| --- | --- |
| [security-model.md](./security-model.md) | Authority-boundary audit: untrusted content -> agent -> MCP/plugin -> exec -> Git/SSH, per-hop gates, tests, and residual risk |
| [execution-custody.md](./execution-custody.md) | Withdrawing authority after it was granted: invariant tripwire, custody journal, halt/contain/preserve/report, explicit reauthorization |
| [remote-ssh-workspaces.md](./remote-ssh-workspaces.md) | Opening projects over SSH: setup, auth, host pinning, what works remotely |
| [canvas-mode.md](./canvas-mode.md) | Workbench: multiple chats and terminals side by side on one worktree _(nav label: "Workbench")_ |
| [chat-archiving.md](./chat-archiving.md) | Right-click a chat to archive it; the Archive page, restoring, and retention flagging |

### Git

| Doc | What it covers |
| --- | --- |
| [git-workspace.md](./git-workspace.md) | The full-page Git tab and its relationship to the Git Sidebar |
| [behavioral-merge-review.md](./behavioral-merge-review.md) | Cross-lane collision signals, merge review gate, provenance, and restart recovery |
| [git-authentication.md](./git-authentication.md) | One-shot push credential prompts; nothing is persisted |
| [git-commit-signing.md](./git-commit-signing.md) | Signing passphrase prompts for GPG/SSH-signed commits |

### Editor and Writer

| Doc | What it covers |
| --- | --- |
| [code-editor.md](./code-editor.md) | The CodeMirror-based editor: language intelligence, themes, AI completions |
| [writer-document-formats.md](./writer-document-formats.md) | DOCX/PDF editing through reviewed Markdown working copies |

## Docs site — Extending CrewCode

| Doc | What it covers |
| --- | --- |
| [plugins.md](./plugins.md) | The plugin contract: manifest, permissions, panel API, CLI workflow |
| [plugin-templates.md](./plugin-templates.md) | Copyable starter templates under `examples/plugins/` |

## Content gaps for the site

- **Notifications** — `notifications.md` is a developer API reference; if the
  notification bar needs user documentation, it's a couple of paragraphs, not
  that file.

## Developer docs (repo-only, NOT for the site)

### Design docs and internals

| Doc | What it is |
| --- | --- |
| [conversation-storage.md](./conversation-storage.md) | Replay shards, session store, `/compact` strategies, transcript persistence layers |
| [agent-provider-context.md](./agent-provider-context.md) | Provider switch handoff, history replay fallback, Claude context policy |
| [crewcoder-provider.md](./crewcoder-provider.md) | CrewCoder ACP bridge lifecycle, permissions, models, usage, filesystem, and SSH behavior |
| [agent-activity-overlay.md](./agent-activity-overlay.md) | Passive todo/plan/task overlay projection from provider events |
| [agent-message-markdown.md](./agent-message-markdown.md) | Markdown/Shiki rendering rules for agent replies |
| [tool-calling-breakdown.md](./tool-calling-breakdown.md) | Per-tool rendering spec for tool-call rows |
| [notifications.md](./notifications.md) | Notification bar architecture and `useNotifications()` API reference |
| [crew-orchestrator.md](./crew-orchestrator.md) | Crew orchestrator design spec: state machine, layering, modes |
| [plugins-v0.md](./plugins-v0.md) | Plugin platform v0 implementation snapshot and pre-v1 gates |

### Testing, QA, and process

| Doc | What it is |
| --- | --- |
| [crew-manual-test.md](./crew-manual-test.md) | Manual QA script for supervisor ↔ worker round trips |
| [dogfood-builds.md](./dogfood-builds.md) | Building installable artifacts for private dogfooding |
| [plugin-examples.md](./plugin-examples.md) | Internal planning list of plugin ideas with validation methods |
