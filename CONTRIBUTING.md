# Contributing to CrewCode

Thanks for your interest in CrewCode. Contributions are welcome, but please read this first — CrewCode is maintained by a solo developer, and these guidelines exist to keep that sustainable.

## Before you write code: open an issue first

**Do not open a large pull request without discussing it first.**

For anything beyond a small fix, open an issue describing what you want to change and why, and wait for a maintainer thumbs-up before building it. This protects your time — it's far better to hear "not a direction I want to take" before you've written 1,000 lines than after.

PRs that don't follow this may be closed without a full review, simply because the change wasn't agreed on up front. That's not personal — it's how a one-person project stays maintainable.

## What gets merged

- **Merged readily:** small, focused bug fixes; typo and documentation fixes; clear, self-contained improvements.
- **Discussed first:** new features, new dependencies, architectural changes, or anything touching core flows (agents, git, terminals, worktrees, IPC).
- **Often declined:** scope creep, features outside the project's direction, large refactors, or code the maintainer would not want to own and maintain long-term.

Every merged change becomes the maintainer's responsibility to support indefinitely. A PR being declined usually means "I don't want to maintain this," not "this is bad work." Feel free to keep declined changes in your own fork.

## Pull request expectations

- Keep PRs small and focused on a single concern. Several small PRs beat one large one.
- Match the existing code style and conventions. See [AGENTS.md](./AGENTS.md) for project conventions (file naming, comments, cross-platform rules, the `.ts` over `.d.ts` rule, etc.).
- Run the checks before submitting:
  ```bash
  npm run typecheck
  npm run build
  ```
- Remember CrewCode targets **macOS, Linux, and Windows**, and must work over **SSH/remote** as well as locally. Keep platform-specific behavior behind runtime checks.
- Explain *what* changed and *why* in the PR description. Link the issue it resolves.

## Dependencies

Be conservative about adding new dependencies. Every new package is a maintenance and supply-chain risk. If a change can be done reasonably without a new dependency, prefer that. New dependencies must be justified in the issue discussion.

## Security

CrewCode has filesystem, shell, git, and SSH access — it is security-sensitive. Every PR is reviewed line by line, and changes touching process execution, file access, or dependencies get extra scrutiny.

Do **not** report security vulnerabilities in public issues or pull requests. See [SECURITY.md](./SECURITY.md) for how to report them privately.

## Licensing of contributions

CrewCode is licensed under the **Apache License, Version 2.0**. By submitting a contribution, you agree that it is licensed under the same terms (inbound = outbound), including the patent grant in Section 3. There is no separate contributor license agreement.

## Conduct

Be respectful and constructive. The maintainer will aim to respond to issues and PRs in reasonable time and to decline clearly and politely when something isn't a fit. Please extend the same courtesy.
