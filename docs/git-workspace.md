# Git Workspace

CrewCode has two git surfaces backed by the same state and actions:

- **Git Sidebar** — the compact panel attached to a chat/editor tab.
- **Git Workspace** — a full-page tab (`kind: 'git'`) for focused review work.

Both stay behaviorally consistent by design: they share the `useGitSidebar`
hook, so staging, committing, branch operations, and refresh behave the same in
either surface. Page-specific differences are layout only.

## Opening it

- CrewCode app menu → **Git Workspace**
- Workspace drawer, App tab → **Git Workspace** ("Review changes, commits, PRs,
  and worktrees")
- Window tab `+` menu

The page always reflects the active workspace's repository and worktree.

## What's on the page

- **Branch control** — the current branch is shown inline in the header; click
  it to open the branch picker (search, switch, or create a new branch from the
  current one).
- **Overview cards** — quick counts for changes and recent history.
- **Changes** — the working-tree file list with staging and diff review.
- **Commit** — commit message + commit action, including signing support.
- **Sidebar sections** — history, branches, and the remaining Git Sidebar
  sections render on the right (with the commit/changes sections hidden, since
  the page has its own).

## Authentication prompts

- Pushes that need credentials open the one-shot
  [Git authentication](./git-authentication.md) modal.
- Signed commits with a passphrase-protected key open the
  [signing passphrase](./git-commit-signing.md) modal.

## Notes for contributors

Keep Git Sidebar and Git Workspace behavior consistent. Page-specific changes
belong in `GitPage`/CSS; only change `useGitSidebar` when the underlying git
behavior itself changes, since both surfaces consume it.
