# Dogfood desktop builds

Use these commands to build installable CrewCode artifacts for private dogfooding before public release.

## Linux

On Linux, build an AppImage:

```bash
npm run dist:linux:appimage
```

Output lands in `release/`, for example:

```txt
release/CrewCode-1.0.0-x64.AppImage
```

Run it directly:

```bash
chmod +x release/CrewCode-*-x64.AppImage
./release/CrewCode-*-x64.AppImage
```

To also build a `.deb`:

```bash
npm run dist:linux
```

## Unpacked local build

For a faster packaging sanity check without creating installers:

```bash
npm run pack
```

This writes an unpacked app under `release/`.

## macOS and Windows

Scripts are available for CI or native machines:

```bash
npm run dist:mac
npm run dist:win
```

Notes:

- Build macOS artifacts on macOS for reliable signing/notarization later.
- Build Windows artifacts on Windows or a CI image with the required Wine/NSIS tooling.
- Linux AppImage builds are the recommended local dogfood path from your Linux machine.

## What gets packaged

- Electron main/preload/renderer output from `out/`.
- Runtime dependencies, including unpacked `node-pty` native files.
- Dogfood plugin examples, available both inside the app and as extra resources so Settings → Plugins can copy examples in packaged builds.

Artifacts are not published by these commands. Publishing remains a separate release step.
