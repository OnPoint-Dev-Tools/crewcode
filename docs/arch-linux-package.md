# Arch Linux package

Until CrewCode can be listed in the Arch User Repository (AUR), this repository
ships a manual `crewcode-bin` PKGBUILD in [`packaging/arch`](../packaging/arch/).
It downloads the official x86_64 Debian release artifact, verifies its SHA-256
checksum, and repackages its files as a native package managed by pacman. Arch
does not install the Debian package directly.

Only x86_64 is currently supported because CrewCode does not yet publish a Linux
ARM64 artifact.

## Install

Install Arch's standard package-building tools if needed:

```bash
sudo pacman -S --needed base-devel git
```

Clone CrewCode, inspect the package recipe, then build and install it:

```bash
git clone https://github.com/OnPoint-Dev-Tools/crewcode.git
cd crewcode/packaging/arch
less PKGBUILD
makepkg -si
```

`makepkg` downloads the pinned CrewCode release and refuses to build if its
checksum does not match. `pacman` installs the resulting `crewcode-bin` package.
Launch CrewCode from the desktop application menu or run:

```bash
crewcode
```

Optional integrations such as an AI agent CLI must still be installed and
authenticated separately.

## Upgrade

Pull a repository revision containing an updated PKGBUILD and rebuild it:

```bash
cd crewcode
git pull --ff-only
cd packaging/arch
makepkg -si
```

Until the package reaches AUR, AUR helpers cannot discover upgrades
automatically.

## Uninstall

```bash
sudo pacman -Rns crewcode-bin
```

This removes application files managed by pacman. It does not remove the user's
CrewCode configuration and data.

## Maintainer release update

After publishing a stable GitHub release with a matching
`CrewCode-<version>-amd64.deb` artifact:

1. Set `pkgver` to the release version and reset `pkgrel` to `1`.
2. Replace `sha256sums_x86_64` with the artifact's SHA-256 checksum. Never use
   `SKIP` for a release binary.
3. Regenerate metadata from `packaging/arch`:

   ```bash
   makepkg --printsrcinfo > .SRCINFO
   ```

4. Run `makepkg --cleanbuild`, install the result, and verify both the desktop
   launcher and `crewcode` command.
5. If available, run `namcap PKGBUILD` and `namcap crewcode-bin-*.pkg.tar.zst`
   and review its findings before committing.

When AUR account registration becomes available, the contents of
`packaging/arch` can be pushed to the separate AUR Git repository for
`crewcode-bin`.
