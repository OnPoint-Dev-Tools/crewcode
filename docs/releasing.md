# Releasing CrewCode

Two commands cover the whole loop: `ship` for day-to-day work, `release` for
versioned builds that the in-app updater can consume.

## Day-to-day

```bash
npm run ship -- "feat: add lane collapse to crew timeline"
```

Stages everything, commits with that message, pushes. Creates the upstream
branch on first push. Refuses to run on a detached HEAD. If there is nothing to
commit it just pushes existing commits.

## Cutting a release

```bash
npm run release          # patch: 0.1.0 -> 0.1.1
npm run release:minor    # 0.1.0 -> 0.2.0
npm run release:major    # 0.1.0 -> 1.0.0
npm run release -- 1.2.3 # explicit version
```

The script refuses to proceed unless:

- the working tree is clean (`npm version` commits, and a dirty tree would sweep
  unrelated work into the version commit),
- you are on `main`,
- `main` has no unpushed commits (a tag ahead of its commits builds a ref GitHub
  does not have).

Then it runs `typecheck` + `test`, bumps the version, tags `vX.Y.Z`, and pushes
with `--follow-tags`.

The npm verification and version subprocesses run in explicit CI mode with stdin
disconnected. This keeps nested test and commit processes out of interactive shell
job control, preventing fish or another POSIX shell from suspending the release when
a child attempts to read from the terminal. Git fetch/push retain terminal access so
configured credential helpers can still authenticate. A verification command that
needs input must fail explicitly rather than leaving a stopped release job that could
later resume and mutate version/tag state.

## What CI does

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds on
three runners in parallel:

| Runner | Artifacts |
| --- | --- |
| `ubuntu-latest` | AppImage, deb |
| `windows-latest` | nsis installer, portable exe |
| `macos-latest` | dmg, zip |

Each runner runs `npm run rebuild` before packaging. This is not optional:
`package.json` sets `npmRebuild: false`, so `node-pty` is never rebuilt against
Electron's ABI automatically and the packaged app dies on the first terminal
spawn without it.

`fail-fast` is off so one platform failing does not cancel the others — but see
the draft note below.

## Publishing the draft

`build.publish.releaseType` is `draft`. All three runners upload into the same
draft release, and **nothing reaches users until you publish it**. That is
deliberate: it lets you confirm all platform artifacts landed before the
`electron-updater` feed goes live.

```bash
gh release list
gh release edit v0.1.1 --draft=false
```

## Updating the Linux web installer

The universal Linux installer is pinned to one stable release instead of trusting
a mutable `latest` download. After publishing a new stable release:

1. Update the version, Debian SHA-256, and AppImage SHA-256 in
   `scripts/install-linux.sh`. Obtain digests from the published GitHub assets,
   not from a local build with the same filename.
2. Update `packaging/arch/PKGBUILD` and regenerate its `.SRCINFO`.
3. Run the installer's `--dry-run` checks and isolated Arch, Debian, and AppImage
   method tests.
4. Copy the verified script byte-for-byte to `public/install` in the separate
   `CjLogic/crewcode-website` repository, build that site, and verify
   `dist/install` still matches.
5. Deploy the website and confirm
   `https://crewcode.logixhub.icu/install` starts with `#!/bin/sh` and does not
   return the SPA HTML fallback.

The public installer refuses root execution, prompts before installation, and
uses native packages on Arch/Debian with a user-local AppImage fallback. Do not
replace the pinned checksums with `SKIP` or runtime parsing of an unsigned
`latest` response.

## Release channels

Two trains, and the distinction is **prerelease vs not** — not electron-builder
named channels. Named channels would need a separate `<channel>.yml` feed
published per train; GitHub prereleases are one feed the client filters.

| Channel | Setting effect | Tags it sees |
| --- | --- | --- |
| `stable` | `allowPrerelease = false`, `allowDowngrade = true` | `v0.2.0` |
| `nightly` | `allowPrerelease = true` | `v0.2.0` and `v0.2.0-nightly.1` |

Cut a nightly by tagging a prerelease version:

```bash
npm run release -- 0.2.0-nightly.1
```

`release.yml` reads the tag: any `-` in it sets `EP_PRE_RELEASE=true`, so the
GitHub Release is flagged prerelease and only nightly users are offered it.

`allowDowngrade` is on for stable so someone switching back from nightly can
land on the newest stable build — without it, a `0.2.0-nightly.3` install would
never see `0.2.0` stable, because it does not compare as newer.

Settings live in renderer localStorage and main has no settings store, so the
channel reaches `autoUpdater` only via `updater:configure`. `App` pushes that
config on launch through `useUpdaterNotices`, and `UpdatesSection` re-pushes
whenever channel or auto-download changes. Main defaults to `stable` + no
auto-download until that first message arrives, so the pre-config window can
never pull a prerelease.

## How the update reaches users

`src/main/updater.ts` registers `electron-updater` against the `build.publish`
block in `package.json` — currently `OnPoint-Dev-Tools/crewcode`. **This must match the
repo you actually release to.** If it drifts, `checkForUpdates()` polls a repo
with no releases and reports "not-available" forever, with no visible error.

Packaged apps auto-check 30s after launch and broadcast `updater:event` to the
renderer. `available` and `downloaded` events also land on the global
notification bar with the new version so the user does not have to open
Settings to learn an update exists; clicking the card opens **Settings →
Updates**. Checking, progress, errors, and "already current" stay off the
bar. The user picks one **Automatic updates** policy, which the renderer
(`updatePolicyToConfig`) expands into the two flags main's `applyConfig` wants:

| Policy | autoDownload | autoInstallOnAppQuit | Behavior |
| --- | --- | --- | --- |
| Manual | false | false | click check, download, restart yourself |
| Download only | true | false | fetched in background, stays staged until you click restart |
| Automatic | true | true | fetched and installed on next quit |

One enum instead of two booleans because the fourth combination (manual
download + auto-install) is nonsensical — the enum makes it unreachable. Main
still receives two independent flags over `updater:configure` and both default
true on absent/malformed input, so a bad message can never strand a downloaded
update as never-installing. Upgraders holding the old `autoUpdate`/`installOnQuit`
booleans are migrated onto the policy by `migrateUpdatePolicy`. Dev builds short
circuit to an `unconfigured` event.

The version and build hash in Settings come from `app:buildInfo`
(`app.getVersion()` plus a `__BUILD_HASH__` short SHA injected by
`electron.vite.config.ts`). Never hardcode them in the UI — a stale literal
misreports the version at exactly the moment a user checks it, right after an
update.

Auto-update works for AppImage, nsis, and mac zip. `deb`, `portable`, and `dmg`
are distribution-only formats — users on those reinstall manually.

## CI on every push

`.github/workflows/ci.yml` runs `typecheck` + `test` on pushes to `main` and on
PRs. Both workflows install with `--legacy-peer-deps` (xterm's peer range
conflicts with the installed React major).
