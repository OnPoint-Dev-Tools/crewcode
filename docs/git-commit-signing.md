# Git commit signing passphrase

When `commit.gpgsign` is on and the signing key is passphrase-protected, git
cannot prompt for the passphrase in CrewCode's GUI-spawned process. The commit
fails with a signing error.

## Flow

1. `git:commit` runs normally. On failure it returns
   `{ error, signingFailure }`, where `signingFailure` is set by
   `isSigningFailure()` matching gpg/ssh signing error strings.
2. `useGitSidebar`'s `onCommit` sees `signingFailure` and calls
   `onRequestSigningPassphrase` → App shows `GitSigningModal`.
3. If the user enters a passphrase, `git:commitWithPassphrase` retries a forced
   signed commit (`commit -S`) with the passphrase injected per the repo's
   `gpg.format`. A wrong passphrase surfaces as an error (it does **not** silently
   commit unsigned).
4. If the user cancels ("commit unsigned"), the previous behavior runs — a
   `--no-gpg-sign` commit with a "committed unsigned" warning.

## Skipping the prompt

Settings → General → **Always commit unsigned** (`alwaysCommitUnsigned`). When on,
`onCommit` skips `onRequestSigningPassphrase` and goes straight to the unsigned
commit on a signing failure. The hook reads it through a ref so toggling it does
not rebuild the git handlers.

## Passphrase injection (main/git.ts `gitSigningEnv`)

Git routes signing passphrases differently by format, so push's single
`GIT_ASKPASS` trick does not apply:

- **OpenPGP** (`gpg.format` unset or `openpgp`): a temp wrapper is set as
  `-c gpg.program=<wrapper>`; it invokes the real gpg with
  `--pinentry-mode loopback --passphrase-file <0600 tempfile>`. The passphrase is
  never on the argv. **Requires `allow-loopback-pinentry` in `gpg-agent.conf`** —
  if that is off, gpg errors and the message is shown in the modal.
- **SSH** (`gpg.format` = `ssh`): `ssh-keygen -Y sign` reads the key passphrase
  via `SSH_ASKPASS` (with `SSH_ASKPASS_REQUIRE=force`), same mechanism as SSH
  push auth.

The passphrase is used once and the temp dir is removed in `finally`. Nothing is
persisted. Remote (`ssh://`) workspaces are rejected — local repos only, for now.

Push *credential* prompts (username/token) are a separate flow — see
[git-authentication.md](./git-authentication.md).
