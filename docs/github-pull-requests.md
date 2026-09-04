# Pull requests in CrewCode

CrewCode's Git Sidebar and Git Workspace provide an in-app pull-request workflow backed by the authenticated GitHub CLI on the machine that owns the workspace. Creating, reviewing, updating, commenting on, closing, and merging a pull request no longer requires a browser handoff.

## Create a pull request

Open **Pull Requests**, then select **Create pull request**. CrewCode presents one pull request through three focused steps:

1. **Branches** selects the source and base, then measures ahead/behind counts, changed files, and merge conflicts directly against that base.
2. **Details** collects the title, five optional Markdown sections—Description,
   Problem, What changed, Why it changed, and Solution—and the draft or
   ready-for-review state.
3. **Review** confirms the exact source, target, evidence, and content before creation.

New pull requests default to draft. Branch comparison uses read-only Git commands and never checks out or moves a ref. CrewCode passes each creation value as a separate `gh` argument, refreshes GitHub state after the command completes, and reports the observed result in the Git banner. It does not infer success from a URL or open the new pull request in a browser.

Each Details section is optional. CrewCode includes only non-empty sections in
the submitted PR body, using the visible field label as a level-two Markdown
heading. The Review step shows every section and marks omitted content as not
provided, so the author sees the structure before creation. CrewCode does not
generate or infer problem statements, rationale, or solutions.

The Branches step can use **All new commits** or **Pick commits**. The default
uses the current branch as the PR head, so a fresh `dev` to `main` PR contains
only commits that GitHub has not already merged into `main`. Pick-commit mode
assembles a smaller release from the current base-to-head history. Select up to
100 full commit identities and name a new source branch. On confirmation, the
trusted service fetches the latest `origin/<base>`, revalidates every selected
commit against that authoritative range, creates an isolated temporary
worktree from the latest base, and cherry-picks the commits in history order.
Only the new branch is pushed and used as the PR head; the current branch and
worktree are never checked out, rewritten, or dirtied. A cherry-pick conflict
aborts the temporary operation and no branch is pushed.

A draft cannot be merged. The review inspector explains that gate and provides
**Mark ready for review**, backed by `gh pr ready`. After GitHub confirms the
transition, CrewCode reloads the PR evidence; it never treats clicking the
button as proof that the state changed.

## Browse repository pull requests

Select **Pull requests** in the Git Workspace header to open the repository PR
Browser. The launcher includes a badge when the latest bounded GitHub status
contains open pull requests; draft pull requests count as open, while closed and
merged pull requests do not. Background catalogue refreshes update evidence but
never create notification-bar history.

While a Git surface remains active, CrewCode silently refreshes the bounded PR
catalogue once per minute. Pull requests created or changed directly on GitHub by
other users therefore appear in the list and open-count badge without reopening
the workspace. The refresh loop is single-flight, preserves the current selected
PR when it still exists, and does not announce historical or externally observed
state through the notification bar.

Switching outer tabs retains the PR Browser's repository-scoped navigation,
filters, selected file/tab, review summary, and queued inline comments. The PR
creation flow also restores its current step, branch/commit selection, title,
structured body fields, and draft choice. Explicit cancel or successful submit
clears the creation draft; mutation locks and confirmation dialogs never carry
across an unmount.
browser. CrewCode loads up to 100 open, closed, and merged pull requests in one
catalogue request, then filters that observed result locally by **All**,
**Open**, **Closed**, or **Assigned to you**. Closed includes merged pull
requests. Assigned means the authenticated GitHub user is an assignee or a
requested reviewer; CrewCode does not infer assignment from authorship or past
reviews.

**More filters** narrows that same bounded catalogue by observed author, label,
base branch, head branch, review request, or review decision. These filters do
not issue additional GitHub requests. CrewCode remembers the repository's
selected PR, search and filters, middle-pane tab, and selected changed file so
returning to the workspace restores the review position when that evidence is
still present.

When the page opens, it selects a pull request whose head matches the current
branch when one exists. Otherwise, it selects the first result. Selecting a row
loads and caches its real PR details for that open browser session: authored
Markdown, comments and submitted reviews, branch route, reviewers, assignees,
labels, exact creation time, changed-file totals, line counts, and checks. The
header identifies the author by GitHub username and their public GitHub profile
image, links to that public profile, and displays the observed creation date,
time, and timezone. CrewCode retrieves the image through the trusted main/Brain
service, accepts only bounded raster content from GitHub-controlled hosts, and
returns a `data:` image to the renderer. Images are cached by username for the
app session; a failed or rejected image falls back to the GitHub mark.

The middle pane has four standard views, plus a contextual **Conflicts** view
while local PR conflict resolution is active:

- **Overview** always shows **Description**, **Problem**, **What changed**,
  **Why it changed**, and **Solution**. Authored headings and common aliases map
  into those sections. Unstructured body text remains the Description; absent
  sections explicitly say they were not provided instead of manufacturing
  rationale. Additional authored Markdown sections remain visible. The bottom
  of Overview shows the observed GitHub comments and submitted review summaries
  with their authors, states, exact timestamps, and Markdown bodies. An empty
  result is labeled explicitly rather than implying that comments loaded.
- **Timeline** orders the observed PR-open event, commits, issue comments, and
  submitted reviews by their GitHub timestamps.
- **Code changes** loads the real PR patch only when opened, lists GitHub's
  changed-file evidence, and renders the selected single-file patch through
  `PierreDiff`. CrewCode requests GitHub's combined base-to-head diff, not the
  `--patch` format-patch mail series. It strips any defensive mail boundaries
  and folds repeated paths under one canonical `diff --git` header so commit
  envelopes or multiple edits to one file never reach Pierre as multiple
  patches. The file list tracks viewed/unviewed progress and provides previous,
  next, and next-unviewed navigation. GitHub's viewed state is authoritative
  when its GraphQL evidence loads; otherwise CrewCode clearly labels a
  session-only local fallback. Files changed since the viewer's most recent
  completed review are marked, and the expandable review marker lists the
  newer commits GitHub observed.
- **Checks** loads the selected PR's current head, merge requirements, check
  suites, individual jobs, steps, and the first 50 GitHub annotations per job
  on demand. Annotations include their observed file and line range. Expanding
  a GitHub Actions job can load up to 256 KiB of its plain-text log inside
  CrewCode; a truncation label is shown when the bound is reached. Authorized
  users can explicitly confirm a rerun of one job, all failed jobs, or the
  whole workflow. Third-party status providers that do not expose a GitHub
  Actions run retain their observed status and external details link, while
  CrewCode states that in-app logs and reruns are unavailable.
- **Conflicts** appears for a conflicting PR or active conflict-resolution
  operation. It lists the exact unmerged paths and reads Git's stage-2 ours blob
  and stage-3 theirs blob through the trusted registered-root boundary. One
  canonical per-file patch renders those sides in PierreDiff, labeled with the
  PR head and base branch. You can accept the complete ours/theirs side from the
  comparison or edit the resolution result below it. CrewCode refuses to mark a
  manual result resolved while standard conflict markers remain, then saves and
  stages only that exact file. It retains merge-in-progress evidence after the
  last path is staged and keeps explicit continue, abort, and push actions in
  the PR workspace. Binary or oversized evidence is reported explicitly while
  ours/theirs resolution remains available when Git exposes that side.

Non-heading copy across the creation flow, sidebar PR card, repository browser,
timeline, file catalogue, inspector, and review workspace uses the shared
readable PR text scale. Technical metadata remains smaller and monospaced, but
body copy is not rendered at terminal-label sizes.

The repository browser is the canonical PR workspace. Its inspector submits
overall reviews, updates a behind branch, marks drafts ready, prepares local
conflict resolution, closes PRs, and merges with merge/squash/rebase. The PR
catalogue, filters, search, refresh, and shell close controls lock while a
mutation runs so the selected action target cannot change underneath it. Every
destructive confirmation names the exact PR and branches, and CrewCode reloads
the selected GitHub evidence after an observed mutation result.

## Manage pull-request details

The inspector can edit a pull request's title and full Markdown description,
add or remove requested reviewers and assignees, and add or remove repository
labels. Candidate users, suggested reviewers, and labels load only when
**Manage** is opened. Manual reviewer entry remains available for GitHub teams
that are not returned as assignable users. Every mutation stays locked to the
selected PR number, then reloads both the bounded catalogue and selected detail
from GitHub before reporting the observed result.

Open ready pull requests can be converted back to draft after confirmation;
drafts can be marked ready again. Closed, unmerged pull requests can be
reopened after a confirmation that names the PR and branch route. Merged pull
requests remain historical and cannot be reopened. The branch evidence also
shows the observed head commit and last GitHub update time. Copy controls expose
the PR number, URL, head branch, and base branch without opening GitHub.

## Review and merge

The PR Browser's persistent inspector shows review status, changed-line counts,
check evidence, and merge readiness. It can submit an overall comment,
approval, or request-changes review without opening a second review shell. In
**Code changes**, select a diff line number to draft an inline comment against
the exact path, left/right side, line, and observed head commit. Drafts remain
local and visibly pending until one explicit **Submit review** action sends the
summary and all inline comments as one GitHub review. Before submission, the
trusted service reloads the PR head and rejects the review if that commit has
changed; stale comments are never silently retargeted.

Existing GitHub review conversations appear below the selected file diff with
their line range, author, timestamp, Markdown body, outdated state, and
resolved state. **Resolve conversation** and **Reopen conversation** appear
only when GitHub reports that the current viewer is authorized to perform the
corresponding action. These mutations, file-viewed mutations, and review
submission use the registered workspace's authenticated `gh` identity through
the main/Brain boundary. Credentials never enter the renderer.

Git Sidebar's Pull Requests card is intentionally compact. It shows the current
branch's PR status, route, check summary, and merge state, then opens the same PR
Browser used by Git Workspace. It does not maintain a second PR selector,
description view, or mutation state.

Comment and request-changes reviews require a written summary. Approval notes
are optional, but GitHub does not allow a pull-request author to approve their
own PR. CrewCode keeps GitHub authoritative, displays these restrictions beside
the controls, and surfaces the exact rejection returned by `gh`.

When GitHub reports the head branch as behind, **Update branch** invokes GitHub's update-branch operation and reloads the evidence.

The pull-request card also supports:

- approving the pull request;
- leaving a comment;
- closing the pull request after confirmation; and
- opening GitHub as an optional fallback.

The readiness ledger explains observed draft state, conflicts, required review
decisions, required check failures or pending runs, an out-of-date head, and
otherwise-unspecified GitHub repository-rule blockers. Branch-update
permission reasons remain attached to **Update branch** and are not
misrepresented as independent merge rules.

Merging always requires an explicit in-card confirmation. CrewCode refreshes
the selected PR's check and merge context before presenting that confirmation,
names the exact head commit, and asks GitHub to reject the operation if the head
changes. If GitHub's merge-requirements query fails, the inspector reports the
failure and directs the user to **Checks** for the exact error instead of
silently ignoring the merge action. Choose one of the methods supported by GitHub:

- **Create merge commit** preserves the branch commits and adds a merge commit.
- **Squash and merge** combines the pull request into one commit.
- **Rebase and merge** replays the pull-request commits onto the base branch.

For a typical `dev` to `main` release PR, squash is the compact default when the
individual development commits are not useful release history. Use a merge
commit when preserving the PR branch boundary matters. Use rebase when each
individual commit is intentionally curated and should remain visible in a
linear `main` history.

When the repository supports auto-merge, an authorized user can enable it with
the selected merge method or disable it after explicit confirmation. When the
base branch uses a merge queue, the primary action submits the exact PR head to
that queue and shows GitHub's observed queue state and position. A queue or
auto-merge request is never described as a completed merge.

GitHub remains authoritative for repository rules, required checks, required reviews, conflicts, enabled merge methods, auto-merge, and merge queues. A rejected `gh` command is shown as an error; CrewCode reports completion only after reloading GitHub and observing the expected merged, auto-merge, or queued state.

## Resolve merge conflicts

When GitHub reports that a PR merge commit cannot be created cleanly, the
review inspector offers **Resolve conflicts in CrewCode**. This is an explicit,
confirmed local workflow; CrewCode does not run `gh pr checkout` or implicitly
switch the active worktree.

Before changing Git state, main verifies that the current worktree is attached
to the exact PR head branch and has no staged, unstaged, or untracked changes.
It then runs the equivalent of:

```text
git fetch origin <base>
git merge --no-edit origin/<base>
```

Every argument is passed separately and both refs are validated. If the merge
is clean, CrewCode opens the contextual **Conflicts** tab at its push step. If
Git observes unmerged paths, that tab lists the exact files instead of sending
you back to Git Workspace. Select a file and edit its conflict markers, or
explicitly choose **Use ours** or **Use theirs** for the complete file. **Save
and mark resolved** writes through the registered-root filesystem boundary and
stages that exact path after checking that standard conflict markers were
removed. The comparison is an observed, bounded stage-2-to-stage-3 Git diff;
it is not reconstructed from the marker-filled working file. **Continue
merge** remains available after the last
conflict is staged because merge-in-progress state comes from observed
`MERGE_HEAD`, not from the continued presence of an unmerged file. **Abort
merge** restores the pre-merge state and exits the contextual workspace. After
continuing, **Push `<head>`** updates the exact PR branch, reloads GitHub detail
and check evidence, and returns to Checks before another confirmed merge
attempt. Every local mutation rechecks that the worktree is still on the
selected PR head; target drift is refused.

GitHub's suggested `--auto` flag is intentionally not treated as conflict
resolution. Auto-merge only queues the final merge after conflicts, checks,
reviews, and repository rules are satisfied.

## Desktop and web behavior

Electron invokes the local authenticated `gh` CLI. A browser connected to a Brain uses the same typed CrewCode client contract. PR catalogue, comparison, detail, diff, conflict-side evidence, public avatar, review-context, management choices, detailed check context, and bounded check-log methods require `workspace:read`; creation, conflict resolution and staging, detail and metadata editing, draft/ready transitions, review submission, branch update, check reruns, auto-merge or queue changes, close/reopen, and merge require `workspace:write`. Every operation remains confined to a registered workspace root. GitHub credentials never cross into the renderer or browser.

This GitHub workflow is separate from crew integration. Crew lane merges continue to use the provenance journal, behavioral verification, and explicit apply gate documented in [Behavioral merge review](behavioral-merge-review.md).

## Current limits

- Review replies inside an existing GitHub thread are not yet composed in CrewCode; new exact-line comments, overall reviews, and authorized resolve/reopen actions are supported.
- Some third-party check providers expose only status and a details URL through GitHub. Their private logs and rerun controls cannot be shown in CrewCode unless they surface a GitHub Actions run.
- GitHub PR operations, including local conflict preparation, are unavailable for `ssh://` workspaces in this release because the authenticated `gh` and Git processes currently run only on the workspace-owning local/Brain host. CrewCode reports this explicitly instead of attempting the command against an invalid local path.
