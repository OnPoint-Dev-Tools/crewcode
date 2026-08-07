#!/usr/bin/env bash
# Install CrewCode AppImage into the desktop environment.
# Extracts .desktop and icon files so the taskbar icon appears correctly.
# Usage: ./scripts/install-appimage.sh [path/to/CrewCode.AppImage]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Find the AppImage
if [[ $# -ge 1 ]]; then
    APPIMAGE="$(realpath "$1")"
else
    # Find the most recent AppImage in release/
    APPIMAGE="$(find "$PROJECT_DIR/release" -maxdepth 1 -name "CrewCode*.AppImage" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
    if [[ -z "$APPIMAGE" ]]; then
        echo "No AppImage found in release/. Build one first with: npm run dist:linux:appimage"
        exit 1
    fi
fi

if [[ ! -f "$APPIMAGE" ]]; then
    echo "AppImage not found: $APPIMAGE"
    exit 1
fi

echo "Installing: $(basename "$APPIMAGE")"

# ─── Directories ───────────────────────────────────────────────────────────────
DESKTOP_DIR="${HOME}/.local/share/applications"
ICONS_DIR="${HOME}/.local/share/icons/hicolor"
TEMP_DIR="$(mktemp -d)"

trap 'rm -rf "$TEMP_DIR"' EXIT

# ─── Extract AppImage ────────────────────────────────────────────────────────
echo "Extracting .desktop and icons..."
"$APPIMAGE" --appimage-extract >/dev/null 2>&1

# Move extracted squashfs-root into temp dir
mv "$PROJECT_DIR/squashfs-root" "$TEMP_DIR/"

# ─── Install icons ─────────────────────────────────────────────────────────────
mkdir -p "${ICONS_DIR}/256x256/apps" "${ICONS_DIR}/512x512/apps"

for size in 256 512; do
    src="${TEMP_DIR}/squashfs-root/usr/share/icons/hicolor/${size}x${size}/apps/crewcode.png"
    if [[ -f "$src" ]]; then
        cp "$src" "${ICONS_DIR}/${size}x${size}/apps/crewcode.png"
        echo "  Installed icon ${size}x${size}"
    fi
done

# ─── Install .desktop file ───────────────────────────────────────────────────
mkdir -p "$DESKTOP_DIR"

# Read the desktop entry from the AppImage and rewrite the Exec= line
# to point to the actual AppImage file path.
DESKTOP_FILE="${TEMP_DIR}/squashfs-root/crewcode.desktop"
if [[ ! -f "$DESKTOP_FILE" ]]; then
    echo "Error: crewcode.desktop not found inside AppImage"
    exit 1
fi

# Rewrite Exec= to point to the actual AppImage, and strip X-AppImage-Version
sed -e "s|Exec=.*|Exec=${APPIMAGE} %U|" \
    -e '/^X-AppImage-Version/d' \
    "$DESKTOP_FILE" > "${DESKTOP_DIR}/crewcode.desktop"

echo "  Installed .desktop file"

# ─── Refresh desktop database ──────────────────────────────────────────────────
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    echo "  Updated desktop database"
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "${ICONS_DIR}" 2>/dev/null || true
    echo "  Updated icon cache"
fi

# ─── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "CrewCode installed. The icon should appear in your application menu / taskbar."
echo "Launch: ${APPIMAGE}"
