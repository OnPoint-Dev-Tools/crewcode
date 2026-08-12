# Behavioral merge review

Git worktrees prevent concurrent writers from editing the same checkout, but they do not make independently valid changes compatible. CrewCode therefore treats a clean Git merge as **combined, not verified**.

## Cross-lane review

For isolated crews, **Cross-lane Diff** and the merge sidebar show:

- every lane's changed files relative to the crew base branch;
- the lane branch, worktree, and current commit SHA that own those changes;
- whether the lane currently has a running agent;
- exact files changed by more than one lane; and
- likely cross-file contract collisions.

The contract heuristics are intentionally narrow and explainable. They cover database migration/schema changes versus model/API consumers, API schemas versus clients/generated code, dependency manifests versus runtime source, and configuration versus consuming source. The sidebar lists the implicated lanes and paths. These warnings are review signals, not proof of a defect; no warning is not proof that combined behavior is correct.

## Combined integration gate

Crew lanes are no longer merged into the base one at a time. **Verify combined lanes** snapshots the base and every committed lane SHA, creates a detached disposable worktree under `.worktrees/`, and merges all candidate SHAs there in displayed order. The user's base checkout remains untouched.

CrewCode then discovers the allowlisted `typecheck` and `test` package scripts using the repository's lockfile-selected package manager and runs them against that exact combined tree. This catches failures that no lane can expose alone—for example, a DB migration in one lane changing a column while a model/API lane independently changes the consumer to an incompatible name. Agents cannot submit arbitrary commands through this route; main runs only discovered check IDs, with `CI=1`, a two-minute local timeout, and bounded output. Local and SSH workspaces are supported.

A passing candidate is retained by an internal Git ref. **Apply checked integration** rechecks all of the following before updating the base:

- the base checkout is clean and still has the expected base branch checked out;
- the base branch still points to the verified base SHA;
- every lane branch still points to its verified SHA; and
- the retained ref still points to the exact checked integration commit.

Only then does CrewCode use `git merge --ff-only` to apply the checked commit. A changed input makes the candidate stale and requires another verification.

The sidebar reports the result as a **candidate decision**, not as whether CrewCode itself worked. **Candidate rejected** means the safety gate ran and prevented an incompatible or otherwise failing combination from reaching the base. **Ready to apply** means the combined candidate passed the discovered checks. Failed check output is expanded beneath the check so the rejection reason is visible without opening developer tools.

## Restart recovery and evidence

The main process atomically persists a merge journal under CrewCode's user-data directory before combination begins and at every phase transition. Each record contains the session, base branch/SHA, lane label, branch, worktree path, owned files and SHA, current phase, discovered check commands, outputs, status, and timestamps.

After restart, an in-flight operation is shown as `interrupted` instead of implying that it completed. Every check process receives a random custody token plus a persisted local PID or remote PID file. Restart reconciliation probes the PID and verifies the token through the process environment where the operating system exposes it, reporting `running`, `exited`, or `unknown` rather than treating a reused PID as evidence. A still-running or unresolved interrupted check blocks another verification run. Platforms that do not expose enough process identity evidence remain `unknown` and require manual resolution; CrewCode does not guess that the process exited.

A candidate that had already passed is reconciled against Git; moved base/lane/ref inputs make it stale. If CrewCode stopped while applying and the base ref now equals the retained integration SHA, that SHA alone is not sufficient evidence of success. Reconciliation also requires `HEAD` to be attached to the expected base branch at the exact integration commit, a clean index and worktree (including untracked files), and no remaining `MERGE_HEAD`. Only then is the operation recorded as applied; otherwise it remains interrupted with the failed checkout/index invariant shown in the sidebar. The base is never inferred to be updated merely because a subprocess had started.

Crew session ownership is also persisted locally. Each lane has an explicit **enabled / paused** switch and an editable **next action** checkpoint, automatically seeded from its latest assignment. Pausing stops the lane runtime but retains its worktree, transcript, and checkpoint; resuming does not auto-submit work. Process-local bridge and terminal IDs are cleared on recovery, lanes that previously said `running` recover as `ready`, and persisted pause/checkpoint state remains visible. The UI never claims an agent process survived without evidence.

Compare and Merge cache their loaded Git evidence by stable lane ownership (lane ID, branch, and path). Runtime status, usage-timer, pause, and checkpoint updates therefore no longer reset those surfaces to a loading state or replay their entry UI while they are open.

## Limits

Path heuristics and project tests cannot understand every runtime assumption, data semantic, deployment order, or external system. The combined gate makes a clean merge testable and auditable; it does not replace migration drills, production safeguards, or human review.
