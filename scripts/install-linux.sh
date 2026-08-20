#!/bin/sh
# CrewCode universal Linux installer.
# Served at https://crewcode.logixhub.icu/install
set -eu

REPOSITORY="OnPoint-Dev-Tools/crewcode"
VERSION="0.2.1"
DEB_NAME="CrewCode-${VERSION}-amd64.deb"
APPIMAGE_NAME="CrewCode-${VERSION}.AppImage"
DEB_SHA256="d8ed0ecce54ebfda70cc5563f5edaba0ec0f671bc1690556895a32d33f92c3c6"
APPIMAGE_SHA256="905edf071502502549777ff292c5c52e3e75ae5bad468dbe1dae223265da878f"
RELEASE_BASE="https://github.com/${REPOSITORY}/releases/download/v${VERSION}"
METHOD="${CREWCODE_INSTALL_METHOD:-auto}"
ASSUME_YES=0
DRY_RUN=0
TMP_DIR=""

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'CrewCode installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install [--method auto|arch|deb|appimage] [--yes] [--dry-run]

  --method METHOD  Override Linux distribution detection.
  --yes            Accept the installer confirmation prompt.
  --dry-run        Print the selected method and artifact without changing files.
  -h, --help       Show this help.
EOF
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

confirm() {
  prompt=$1
  if [ "$ASSUME_YES" -eq 1 ]; then
    return 0
  fi
  if [ ! -r /dev/tty ]; then
    fail "confirmation requires a terminal; rerun with --yes only after reviewing the script"
  fi
  printf '%s [y/N] ' "$prompt" >/dev/tty
  IFS= read -r answer </dev/tty || return 1
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

download() {
  url=$1
  destination=$2
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --output "$destination" "$url"
}

verify_sha256() {
  expected=$1
  file=$2
  printf '%s  %s\n' "$expected" "$file" | sha256sum --check --status - \
    || fail "SHA-256 verification failed for $(basename "$file")"
}

detect_method() {
  if [ "$METHOD" != "auto" ]; then
    return
  fi

  distro_id=""
  distro_like=""
  if [ -r /etc/os-release ]; then
    # /etc/os-release is the standard distribution-provided identification file.
    # shellcheck disable=SC1091
    . /etc/os-release
    distro_id=${ID:-}
    distro_like=${ID_LIKE:-}
  fi

  case " $distro_id $distro_like " in
    *" arch "*) METHOD="arch" ;;
    *" debian "*|*" ubuntu "*) METHOD="deb" ;;
    *) METHOD="appimage" ;;
  esac
}

run_with_tty() {
  if [ "$ASSUME_YES" -eq 1 ]; then
    "$@"
  else
    "$@" </dev/tty
  fi
}

install_arch() {
  need_command sudo
  need_command pacman

  if ! command -v makepkg >/dev/null 2>&1; then
    confirm "Install the Arch base-devel toolchain?" || fail "installation cancelled"
    if [ "$ASSUME_YES" -eq 1 ]; then
      sudo pacman -S --needed --noconfirm base-devel
    else
      run_with_tty sudo pacman -S --needed base-devel
    fi
  fi
  need_command makepkg

  build_dir="${TMP_DIR}/crewcode-bin"
  mkdir -p "$build_dir"
  cat >"${build_dir}/PKGBUILD" <<EOF
pkgname=crewcode-bin
pkgver=${VERSION}
pkgrel=1
pkgdesc='Desktop environment for orchestrating AI coding agents across local project worktrees'
arch=('x86_64')
url='https://github.com/${REPOSITORY}'
license=('Apache-2.0')
depends=('alsa-lib' 'at-spi2-core' 'cairo' 'dbus' 'expat' 'glib2' 'glibc' 'gtk3' 'libcups' 'libdrm' 'libgcc' 'libnotify' 'libsecret' 'libx11' 'libxcb' 'libxcomposite' 'libxdamage' 'libxext' 'libxfixes' 'libxkbcommon' 'libxrandr' 'libxss' 'libxtst' 'mesa' 'nspr' 'nss' 'pango' 'systemd-libs' 'util-linux-libs' 'xdg-utils')
optdepends=('git: local repository and worktree operations' 'github-cli: GitHub pull request integration' 'libappindicator: system tray integration')
provides=('crewcode')
conflicts=('crewcode')
options=('!strip')
_deb='${DEB_NAME}'
source_x86_64=("\${_deb}::${RELEASE_BASE}/${DEB_NAME}")
noextract=("\${_deb}")
sha256sums_x86_64=('${DEB_SHA256}')
package() {
  bsdtar -xOf "\${srcdir}/\${_deb}" data.tar.xz | bsdtar -xf - -C "\${pkgdir}"
  install -d "\${pkgdir}/usr/bin"
  ln -s /opt/CrewCode/crewcode "\${pkgdir}/usr/bin/crewcode"
  install -d "\${pkgdir}/usr/share/licenses/\${pkgname}"
  ln -s /opt/CrewCode/resources/licenses/LICENSE "\${pkgdir}/usr/share/licenses/\${pkgname}/LICENSE"
}
EOF

  say "Building CrewCode ${VERSION} as a pacman-managed package."
  confirm "Continue with makepkg and pacman installation?" || fail "installation cancelled"
  if [ "$ASSUME_YES" -eq 1 ]; then
    (cd "$build_dir" && makepkg --syncdeps --install --noconfirm)
  else
    (cd "$build_dir" && run_with_tty makepkg --syncdeps --install)
  fi
}

install_deb() {
  need_command curl
  need_command sha256sum
  need_command sudo
  need_command apt-get
  need_command dpkg

  artifact="${TMP_DIR}/${DEB_NAME}"
  say "Downloading CrewCode ${VERSION} Debian package."
  download "${RELEASE_BASE}/${DEB_NAME}" "$artifact"
  verify_sha256 "$DEB_SHA256" "$artifact"
  say "Verified ${DEB_NAME} with SHA-256."
  confirm "Install CrewCode with apt-get?" || fail "installation cancelled"
  if [ "$ASSUME_YES" -eq 1 ]; then
    sudo apt-get install -y "$artifact"
  else
    run_with_tty sudo apt-get install "$artifact"
  fi
}

escape_desktop_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g'
}

install_appimage() {
  need_command curl
  need_command sha256sum
  need_command sed

  artifact="${TMP_DIR}/${APPIMAGE_NAME}"
  say "Downloading CrewCode ${VERSION} AppImage."
  download "${RELEASE_BASE}/${APPIMAGE_NAME}" "$artifact"
  verify_sha256 "$APPIMAGE_SHA256" "$artifact"
  say "Verified ${APPIMAGE_NAME} with SHA-256."
  confirm "Install CrewCode for the current user under ~/.local?" || fail "installation cancelled"

  app_dir="${HOME}/.local/opt/crewcode"
  bin_dir="${HOME}/.local/bin"
  applications_dir="${HOME}/.local/share/applications"
  icon_dir="${HOME}/.local/share/icons/hicolor/512x512/apps"
  app_path="${app_dir}/CrewCode.AppImage"

  mkdir -p "$app_dir" "$bin_dir" "$applications_dir" "$icon_dir"
  install -m 0755 "$artifact" "$app_path"
  ln -sfn "$app_path" "${bin_dir}/crewcode"

  extract_dir="${TMP_DIR}/appimage-extract"
  mkdir -p "$extract_dir"
  if (cd "$extract_dir" && "$app_path" --appimage-extract \
      'usr/share/icons/hicolor/512x512/apps/crewcode.png' >/dev/null 2>&1); then
    install -m 0644 \
      "${extract_dir}/squashfs-root/usr/share/icons/hicolor/512x512/apps/crewcode.png" \
      "${icon_dir}/crewcode.png"
    desktop_icon="crewcode"
  else
    desktop_icon="$app_path"
  fi

  desktop_exec=$(escape_desktop_value "${bin_dir}/crewcode")
  cat >"${applications_dir}/crewcode.desktop" <<EOF
[Desktop Entry]
Name=CrewCode
Exec="${desktop_exec}" %U
Terminal=false
Type=Application
Icon=${desktop_icon}
StartupWMClass=crewcode
Comment=Desktop environment for orchestrating AI coding agents
Categories=Development;
EOF

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
  fi

  say "CrewCode installed at ${app_path}"
  case ":${PATH}:" in
    *":${bin_dir}:"*) ;;
    *) say "Add ${bin_dir} to PATH to run 'crewcode' from a terminal." ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --method)
      [ "$#" -ge 2 ] || fail "--method requires a value"
      METHOD=$2
      shift 2
      ;;
    --method=*) METHOD=${1#*=}; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$METHOD" in
  auto|arch|deb|appimage) ;;
  *) fail "unsupported method: $METHOD (expected auto, arch, deb, or appimage)" ;;
esac

[ "$(uname -s)" = "Linux" ] || fail "this installer currently supports Linux only"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "CrewCode Linux releases currently support x86_64 only"
  ;;
esac
[ "$(id -u)" -ne 0 ] || fail "do not run this installer as root; it requests sudo only when needed"

detect_method

case "$METHOD" in
  arch) artifact_description="${DEB_NAME} repackaged with makepkg" ;;
  deb) artifact_description="${DEB_NAME}" ;;
  appimage) artifact_description="${APPIMAGE_NAME}" ;;
esac

say "CrewCode Linux installer"
say "Version: ${VERSION}"
say "Method: ${METHOD}"
say "Artifact: ${artifact_description}"

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run complete; no files were changed."
  exit 0
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/crewcode-install.XXXXXX")

case "$METHOD" in
  arch) install_arch ;;
  deb) install_deb ;;
  appimage) install_appimage ;;
esac

say "CrewCode ${VERSION} installation complete."
