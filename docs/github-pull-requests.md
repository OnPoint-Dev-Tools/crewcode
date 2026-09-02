# Pull requests in CrewCode

CrewCode's Git Sidebar and Git Workspace provide an in-app pull-request workflow backed by the authenticated GitHub CLI on the machine that owns the workspace. Creating, reviewing, updating, commenting on, closing, and merging a pull request no longer requires a browser handoff.

## Create a pull request

Open **Pull Requests**, then select **Create pull request**. CrewCode presents one pull request through three focused steps:

1. **Branches** selects the source and base, then measures ahead/behind counts, changed files, and merge conflicts directly against that base.
2. **Details** collects the title, optional Markdown description, and draft or ready-for-review state.
3. **Review** confirms the exact source, target, evidence, and content before creation.

New pull requests default to draft. Branch comparison uses read-only Git commands and never checks out or moves a ref. CrewCode passes each creation value as a separate `gh` argument, refreshes GitHub state after the command completes, and reports the observed result in the Git banner. It does not infer success from a URL or open the new pull request in a browser.

## Review and merge

The sidebar shows one selected pull request at a time. **Review in CrewCode** opens a full review workspace with three views:

- **Overview** shows commits, the PR description, issue comments, and submitted reviews.
- **Files** lists GitHub's changed-file evidence and renders the selected file's real PR patch through `PierreDiff`.
- **Checks** shows the PR's status-check rollup and links to check details when available.

The persistent inspector shows review status, changed-line counts, check evidence, and merge readiness. It can submit an overall comment, approval, or request-changes review. Inline line-level review comments are not implemented yet; CrewCode does not fabricate them from an overall review.

When GitHub reports the head branch as behind, **Update branch** invokes GitHub's update-branch operation and reloads the evidence.

The pull-request card also supports:

- approving the pull request;
- leaving a comment;
- closing the pull request after confirmation; and
- opening GitHub as an optional fallback.

Merging always requires an explicit in-card confirmation. Choose one of the methods supported by GitHub:

- **Create merge commit** preserves the branch commits and adds a merge commit.
- **Squash and merge** combines the pull request into one commit.
- **Rebase and merge** replays the pull-request commits onto the base branch.

GitHub remains authoritative for repository rules, required checks, required reviews, conflicts, and enabled merge methods. A rejected `gh` command is shown as an error; CrewCode labels the action successful only when the merge command itself reports success, then refreshes GitHub state to reconcile the card.

## Desktop and web behavior

Electron invokes the local authenticated `gh` CLI. A browser connected to a Brain uses the same typed CrewCode client contract. PR comparison, detail, and diff methods require `workspace:read`; creation, review submission, branch update, close, and merge require `workspace:write`. Every operation remains confined to a registered workspace root. GitHub credentials never cross into the renderer or browser.

This GitHub workflow is separate from crew integration. Crew lane merges continue to use the provenance journal, behavioral verification, and explicit apply gate documented in [Behavioral merge review](behavioral-merge-review.md).

## Current limits

- Overall PR reviews are supported; inline line-level review comments are not yet mapped to GitHub review threads.
- GitHub PR operations are unavailable for `ssh://` workspaces in this release because the authenticated `gh` process currently runs only on the workspace-owning local/Brain host. CrewCode reports this explicitly instead of attempting the command against an invalid local path.
