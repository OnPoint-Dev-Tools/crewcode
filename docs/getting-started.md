# Getting started

CrewCode is a desktop ACE (Agent Coding Environment) for running AI coding
agents — solo or as a [crew](./using-crews.md) — across git worktrees, with
chat, terminals, a code editor, and git review in one window.

## Install

Download the latest stable Linux, macOS, or Windows artifact from
[GitHub Releases](https://github.com/OnPoint-Dev-Tools/crewcode/releases/latest).

On x86_64 Linux, download and review the universal installer before running it:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo install-crewcode.sh \
  https://crewcode.logixhub.icu/install
less install-crewcode.sh
sh install-crewcode.sh
```

The installer uses pacman on Arch-based systems, apt on Debian-based systems,
and a user-local AppImage elsewhere. It verifies the pinned release checksum,
refuses root execution, and prompts before installation. The convenience form
is:

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://crewcode.logixhub.icu/install | sh
```

Arch Linux users can alternatively build a pacman-managed `crewcode-bin` package
using the [manual Arch package instructions](./arch-linux-package.md). The recipe
verifies and repackages CrewCode's official release artifact; it does not install
a Debian package directly.

### Build from source (contributors)

Requirements: Node.js 22.16 or newer, git.

```bash
git clone https://github.com/OnPoint-Dev-Tools/crewcode.git
cd CrewCode
npm install --legacy-peer-deps
npm run dev          # dev build: Vite renderer + Electron
```

To build an installable artifact yourself:

```bash
npm run dist:linux   # AppImage + deb → release/
npm run dist:mac     # dmg + zip (build on macOS)
npm run dist:win     # NSIS installer + portable (build on Windows)
```

## Agent providers

CrewCode drives agent CLIs you already have. Install the ones you want to use
and make sure they're on your `PATH` — CrewCode detects them automatically
(including version-manager installs like mise/asdf/volta/bun):

- **Claude Code**, **Codex**, **OpenCode**, **pi**, **Hermes**, **CrewCoder** — CLI providers
- **Ollama** — local models over HTTP (needs the `ollama` binary)
- **OpenRouter** — hosted models; add your API key in **Settings → Providers**

A provider that isn't detected shows as unavailable in the model picker.

## First run

1. **Add a project** — workspace drawer → Add project: browse a local folder,
   clone from URL, initialize a new repo, or connect a
   [remote SSH project](./remote-ssh-workspaces.md).
   Local project favicons appear in the workspace drawer and active workspace
   dock. CrewCode checks common web asset folders plus Electron's conventional
   `build/` folder; projects without a usable icon keep the status dot.
   Right-click any project to create an organizational folder. Once at least
   one folder exists, the same menu also offers moving projects between folders.
   Workspace groups stay together at the top of the drawer, and each section has
   an icon for quick scanning. Local workspace paths abbreviate your home folder
   with `~` (for example, `~/developing/DEV-TOOLS/CrewCode`); hover the path to
   see its full absolute value. Remote SSH roots stay unchanged. Selecting a
   workspace loads only its chats in the **Threads** section below the global
   Working, Completed, and Terminals shortcuts. Right-click a chat to pin it;
   pinned chats stay at the top of their existing Threads or Delegated list and
   persist across restarts. Completed shortcuts disappear one hour after a turn
   finishes if you do not select them; this never deletes the chat or transcript
   from Threads.
2. **Start a chat** — pick an agent and model in the composer, choose a mode
   (**ask / plan / build / full**), and send. Plan mode is read-only; you
   switch to build when you're ready for edits.
3. **Watch the work** — tool calls, todos, and diffs stream into the thread.
   The terminal column (`Cmd J`) and code editor live in the same tab.
4. **Review and commit** — the Git Sidebar or the full
   [Git Workspace](./git-workspace.md) tab handles staging, commits, and
   pushes.

From there:

- Run several agents at once with a [crew](./using-crews.md).
- Open multiple chats/terminals side by side in
  [Workbench](./canvas-mode.md).
- Customize [keybindings](./keybindings.md) and the
  [layout panel](./tweaks-panel.md).
- Extend the app with [plugins](./plugins.md).
