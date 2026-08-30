# Git Workspace

CrewCode has two git surfaces backed by the same state and actions:

- **Git Sidebar** — the compact panel attached to a chat/editor tab.
- **Git Workspace** — a full-page tab (`kind: 'git'`) for focused review work.

Both stay behaviorally consistent by design: they share the `useGitSidebar`
hook, so staging, committing, branch operations, and refresh behave the same in
either surface. Page-specific differences are layout only.

On mobile web (`≤768px`), opening Git Sidebar from chat or Code Editor presents
the same sidebar as a right-side overlay with a backdrop and explicit close
control. It never compresses the chat/editor or disappears behind the desktop
splitter rule. The standalone Git Workspace continues to use its responsive
single-column page layout. Its summary remains a compact two-column grid, the
changed-file catalogue stacks above a bounded diff viewport, and the remaining
Git tools follow below in a bounded scroll panel. Git Workspace branch, menu,
stage, and commit controls retain touch-sized targets; commit and branch inputs
use the iOS-safe 16px size.

## Opening it

- CrewCode app menu → **Git Workspace**
- Workspace drawer, App tab → **Git Workspace** ("Review changes, commits, PRs,
  and worktrees")
- Window tab `+` menu

The page always reflects the active workspace's repository and worktree. When
Settings → General → **Default branch** is set, both Git Workspace and Git
Sidebar compare that active worktree against the selected branch without
checking it out. This includes committed work that a plain working-tree status
would omit. Comparison-only rows are review-only; stage/unstage remains
available only for real working-tree changes.

## What's on the page

- **Branch control** — the current branch is shown inline in the header; click
  it to open the branch picker (search, switch, or create a new branch from the
  current one).
- **Overview cards** — quick counts for changes and recent history.
- **Changes** — files changed against the configured default branch (or the
  working tree when none is configured), with staging for local changes and
  Pierre diff review. Staged rows have a minus control to unstage them; right-
  click a row for **stage changes**, **stage all changes**, **unstage changes**,
  or **discard changes**. Discard restores tracked files to `HEAD` (including
  staged changes) and removes untracked files, so it cannot be undone.
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

Git Sidebar changed-file clicks open `CodeEditor`'s existing external-diff
surface and must request the diff from the active worktree path. When a default
branch is configured, use the single-file diff against that ref. Do not checkout
the comparison branch or route the row to a second diff implementation.
