# Git push authentication

When you push from CrewCode's Git surfaces (Git Sidebar or the Git Workspace
tab), git may need credentials for the remote. CrewCode runs git from a
GUI-spawned process, so git cannot prompt on a terminal the way it would in a
shell — instead CrewCode shows its own prompt.

## Flow

1. A push that needs credentials fails; CrewCode detects the auth failure and
   opens the **Git authentication** modal, showing the remote URL it tried to
   reach.
2. Enter your **username** and **password or personal access token** (for
   GitHub/GitLab over HTTPS, use a PAT — most hosts no longer accept account
   passwords for git).
3. **retry push** re-runs the push with the credentials injected through a
   temporary askpass helper (`GIT_ASKPASS` / `SSH_ASKPASS`). A wrong credential
   surfaces the error in the modal so you can correct it.
4. **cancel** aborts the push.

> [!NOTE]
> Credentials are used once for that single git command and are **not saved**
> by CrewCode. Nothing is written to disk beyond a short-lived helper script
> that is removed when the command finishes. If you want persistent
> credentials, configure a git credential helper (`git config credential.helper`)
> or push over SSH with keys — CrewCode respects both, and the modal only
> appears when git itself could not authenticate.

## SSH remotes

Pushes to `ssh://`/`git@` remotes use your normal SSH setup (agent, keys,
`~/.ssh/config`). If an SSH key passphrase is needed, it is requested through
the same one-shot askpass mechanism (`SSH_ASKPASS_REQUIRE=force`).

## Related

- Commit **signing** passphrases (GPG/SSH signing keys) use a separate modal
  and mechanism — see [git-commit-signing.md](./git-commit-signing.md).
- Remote (`ssh://`) workspaces run git on the remote host, where your remote
  credentials/agent apply — see
  [remote-ssh-workspaces.md](./remote-ssh-workspaces.md).
