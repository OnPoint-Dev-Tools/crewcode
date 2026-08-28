<div align="center">

<img src="src/renderer/src/assets/crewcode-dark-version-logo.png" alt="CrewCoder" width="250" />

> **CrewCode is the control center for multi-agent software development.**
>
> Run, supervise, and review multiple AI coding agents across git worktrees without losing control of your repo.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Website](https://img.shields.io/badge/Website-crewcode.logixhub.icu-0b7285.svg)](https://crewcode.logixhub.icu)
[![X](https://img.shields.io/badge/X-@OnPointTools-000000.svg)](https://x.com/OnPointTools)
[![YouTube](https://img.shields.io/badge/YouTube-@CjWisdom-FF0000.svg)](https://www.youtube.com/@CjWisdom)

</div>

<div align="center">

[![CrewCode multi-agent workflow demo](docs/assets/crewcode-demo.gif)](https://youtu.be/--jFB-w31YQ)

**[Watch the full CrewCode demo on YouTube →](https://youtu.be/--jFB-w31YQ)**

</div>

# CrewCode

CrewCode is a free, open-source desktop ACE for developers who already work repo-first and agent-first.

Instead of juggling terminals, worktrees, PR pages, browser tabs, and chat threads across several tools, CrewCode keeps the full workflow in one place.

CrewCode is a desktop development environment that runs multiple AI coding agents in parallel within a single window. It integrates chat, real terminals, a code editor, and isolated git worktrees so each agent works on its own branch without conflicts. Developers can mix providers like Claude Code, Codex, OpenCode, Pi, and Ollama, switch models inline, and manage approvals via Mission Control. It’s open source, local-first, supports SSH workspaces, and offers a plugin platform for extensions.

> **Pair CrewCode with [CrewCoder](https://github.com/OnPoint-Dev-Tools/crewcoder)** for an integrated agentic development workflow. CrewCode includes first-class CrewCoder support through ACP, so you can run and supervise CrewCoder directly from the app and ask it to create custom CrewCode plugins tailored to your workflow. See the [CrewCoder provider guide](./docs/crewcoder-provider.md) for setup details and the [plugin guide](./docs/plugins.md) to learn more about CrewCode plugins.

## Why CrewCode

As soon as you run more than one coding agent, the workflow gets messy fast:

- too many terminals
- too many worktrees
- too many half-finished diffs
- too many browser and PR tabs
- not enough visibility into what each agent is doing

CrewCode is built to make that workflow supervised, inspectable, and easier to land safely.

It targets MacOS (I'd appreciate if someone can help with testing Mac), Linux, and Windows.

## What CrewCode does

### Run multiple agents in one workspace

- Run **CrewCoder agent**, **Claude Code agent**, **Codex**, **OpenCode**, **pi**, **Ollama**, **Hermes**, **OpenRouter** and **Grok Build**from one app
- Mix **structured agent bridges** and **PTY-backed terminals** depending on provider
- Keep multiple chat tabs **sessions per workspace**, each with its own agent, model, mode, and effort
- Resume persistent sessions instead of starting from scratch every time
- Extend CrewCode with local plugins, custom panels, MCP servers, browser/git actions, and plugin-powered agent providers
- Switch Providers Mid Session and it creates an hand-off Summary for new agent to continue work with out leaving chat and losing context
- Workbench Mode: Run multiple chats and terminals all at once on same worktree
- /compact when ever you want and it creates a summary of your recent conversation then you can continue with your work in new session under the hood

### Worktree-native development

- Add existing repos or folders
- Clone repos directly into a local workspace
- Initialize new projects from scratch
- Create, switch, merge, and remove **git worktrees** inside the app
- Keep parallel work isolated without stashing or branch juggling
- Surface exact file overlap and likely cross-file contract collisions before crew merges
- Recover crew worktree/commit ownership and interrupted merge audit state after restart

### Crew orchestration

- Launch a **crew** of agents in parallel
- Configure lanes with different roles, agents, models, and effort levels
- Run agents in isolated worktrees or shared workspace patterns
- Save and reuse crew templates
- Restart, mute, rebroadcast to, and inspect lanes independently

# Delegated Threads

Lets a coding agent create and drive **real, persistent chat sessions** from inside a
turn, so "spin up some agents in another thread to run a regression test, keep me
updated" produces threads you can open, read, and continue yourself.

This is distinct from Crew Surface. Crew lanes are ephemeral, live in one tab, and
exist for the duration of a crew run. Delegated threads are ordinary `Session`s with
transcripts, archiving, and drawer rows — they outlive the turn that made them.

### Control Center for supervision

- See active agents across projects in one dashboard
- Group activity by project, status, type, or worktree
- Spot blocked runs quickly
- Follow a live cross-app activity feed

### Git and review workflow

- View repo status, history, branches, and worktrees
- Stage, unstage, diff, commit, pull, push, fetch, and sync
- Review AI-generated changes inside the app
- Handle merge conflicts and delegate resolution back to an agent
- Create, approve, and merge PRs through GitHub CLI integration

### Writer document workflow

- Draft and review Markdown or plain-text documents beside an agent chat
- Convert DOCX and PDF files into editable Markdown working copies without overwriting originals
- Detect agent edits and review them as Pierre text diffs before accepting or denying
- Export approved working copies to collision-safe DOCX or PDF files

### Browser-to-agent workflow

- Open embedded browser tabs inside CrewCode
- Grab page context from selected elements
- Grab class names from selected elements
- Capture screenshots of browser selections
- Send browser research directly into an agent chat

### Realtime voice and composer dictation

CrewCode includes a provider-neutral realtime voice layer for talking naturally
with the coding agent in the active chat.

- Use the voice orb for voice conversations with your selected coding agent
- Review, edit, or cancel each voice transcript before it is sent to the agent
- Route spoken requests through the existing CrewCode session, workspace, mode, and permission boundaries
- Hear the complete prose reply while omitting code blocks, diffs, tables, logs, URLs, and long paths
- Choose GPT Realtime, xAI Voice, or fully local voice instead of being locked to one provider
- Run local speech with NVIDIA Parakeet TDT 0.6B v2 for transcription and Kokoro-82M with the `am_michael` voice for speech
- Choose Automatic, GPU, or CPU local inference; idle models unload while the lightweight voice sidecar stays available
- Keep hosted provider keys in Electron's main process; permanent keys never enter renderer state
- Use the separate composer microphone for speech-to-text only—it inserts text at the caret for review.

Realtime voice is off by default. Hosted providers require their own API keys
and billing; local voice requires a Python 3.11 environment and the documented
native dependencies. See [`docs/realtime-voice.md`](./docs/realtime-voice.md)
for setup, architecture, provider availability, and security details.

### Prompt and skill library

- Maintain a local library of reusable prompts
- Maintain a local library of reusable skills/instructions
- Apply skills per session
- Track usage and edit prompts/skills in-app

### Operator visibility

- Watch live terminal panes and agent daemon processes
- Inspect CPU and memory usage with the built-in system monitor
- Get notifications when agents finish or need attention

### Workbench/Canvas mode

— Run multiple chats and terminals at once on the same worktree.

### Code Editor

- Language-aware completions via TypeScript/LSP or per-language services.
- Tab Tab Autocomplete with local agents or Hosted API Provider for Completions
- Want your own plugin? tell CrewCoder to create one for you according to your workflow
- Themes, Document Outline, TypeScript and JavaScript intelligence, Problems drawer, Code Actions , Safety and performance and more!

### Local plugin platform

CrewCode now includes a local-first plugin system for trusted developer automation.

- Install plugins from `~/.crewcode/plugins/<plugin-id>/crewcode.plugin.json`
- Add isolated plugin panels, sidebar panels, status items, editor/chat actions, git lenses, browser actions, terminal watcher actions, MCP server declarations, and custom agent providers
- Build plugin UIs as static HTML/JS assets loaded through `crewcode-plugin://` sandboxed iframes
- Use the typed `crewcode-plugin-api` browser package for safe `postMessage` calls into CrewCode
- Approve/revoke permissions, enable/disable plugins globally, and enable/disable plugins per workspace from the dedicated Plugins page
- Debug plugins with categorized logs for manifest validation, asset loading, iframe runtime errors, capability denials, provider spawn failures, and HTTP provider failures

Plugin agent providers support `mock`, `exec`, and `http` runtimes, so you can connect local CLIs or internal HTTP agent gateways without giving plugin UI direct Electron or Node access. See [`docs/plugins.md`](./docs/plugins.md) and [`examples/plugins`](./examples/plugins) for the current v0 contract and templates.

### Environment and integrations

- GitHub auth and PR workflows via `gh`
- SSH config and key inspection
- SSH reachability testing for remote targets
- Auto-update channels: stable, beta, nightly
- Configurable agent launch paths and shell preferences
- Remote hosting: Remote file editing,terminal, and agents connection to host

## Best fit today

CrewCode is strongest today for:

- solo developers running multiple coding agents on real repos
- technical founders using agents as parallel collaborators
- small engineering teams exploring supervised multi-agent workflows

## Typical workflow

1. add or clone a project
2. create or switch to a worktree
3. start one or more agent sessions
4. watch output in chat, terminal panes, and Mission Control
5. inspect diffs, commit changes, open or merge PRs, or discard work

## Install on Linux

The installer detects Arch-based and Debian-based distributions and uses their
native package manager. Other x86_64 Linux distributions receive a user-local
AppImage installation.

Download and review the installer before running it:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo install-crewcode.sh \
  https://crewcode.logixhub.icu/install
less install-crewcode.sh
sh install-crewcode.sh
```

Or use the convenience one-liner after reviewing the
[installer source](./scripts/install-linux.sh):

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://crewcode.logixhub.icu/install | sh
```

The installer verifies the selected `v0.2.1` release artifact with SHA-256 and
prompts before invoking a package manager or writing user-local application
files. It refuses to run as root. Use `sh install-crewcode.sh --dry-run` to see
the selected method without changing files.

### Manual Arch Linux package

Until `crewcode-bin` is available in the AUR, Arch users can instead build and
install the pacman-managed package directly from this repository:

```bash
sudo pacman -S --needed base-devel git
git clone https://github.com/OnPoint-Dev-Tools/crewcode.git
cd crewcode/packaging/arch
less PKGBUILD       # review the package recipe before building
makepkg -si
```

The PKGBUILD downloads CrewCode's official x86_64 release artifact, verifies its
SHA-256 checksum, and repackages it for pacman. Arch does not install the Debian
package directly. See the [Arch Linux package guide](./docs/arch-linux-package.md)
for upgrade, uninstall, and maintainer instructions.

## Development

```bash
npm run dev
npm run build
npm run preview
npm run typecheck
```

## Tech stack

- Electron
- React
- TypeScript
- electron-vite
- xterm
- node-pty

## Contributing

CrewCode is open to contributions — issues, bug reports, and pull requests are all welcome. If you're planning a larger change, open an issue first so we can talk through the approach before you build it.

## License

CrewCode is licensed under the **Apache License, Version 2.0**. See [LICENSE](./LICENSE) for the full text.

In short: you are free to use, modify, and redistribute CrewCode, including in commercial and closed-source products, provided you retain the copyright and license notices and state any significant changes you made. Apache-2.0 also grants an explicit patent license from contributors.

### Third-party components

Some bundled components are under different licenses and are **not** covered by Apache-2.0. See [NOTICE](./NOTICE) for the full list.

Most notably, the file-tree icon set in `src/renderer/src/assets/bearded-icons/` is [Bearded Icons](https://github.com/BeardedBear/bearded-icons) by BeardedBear, licensed under **GPL-3.0**. These assets are used unmodified and are aggregated with — not incorporated into — CrewCode's Apache-licensed source. If you fork CrewCode and need a fully permissive stack, replace that directory with a permissively licensed icon set.

Copyright © 2026 OnPoint Tools.
