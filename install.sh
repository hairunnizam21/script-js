#!/usr/bin/env bash
# ===========================================================================
#  Suzu-JS — all-in-one installer
#  Works on Termux (Android) and Debian/Ubuntu servers. One command installs
#  Node.js + the whole Android RE toolchain, creates a debug keystore, links
#  the `suzu` command, and runs first-time config.
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/hairunnizam21/script-js/main/install.sh | bash
#  or, from a clone:
#    bash install.sh
# ===========================================================================
set -euo pipefail

REPO_URL="https://github.com/hairunnizam21/script-js.git"
RAW_BASE="https://raw.githubusercontent.com/hairunnizam21/script-js/main"

# ---- pretty output --------------------------------------------------------
if [ -t 1 ]; then
  B="\033[1m"; BLUE="\033[38;5;39m"; RED="\033[38;5;196m"; GRN="\033[38;5;46m"
  YEL="\033[33m"; GRY="\033[90m"; RST="\033[0m"
else
  B=""; BLUE=""; RED=""; GRN=""; YEL=""; GRY=""; RST=""
fi
say()  { printf "${BLUE}➜${RST} %s\n" "$*"; }
ok()   { printf "${GRN}✔${RST} %s\n" "$*"; }
warn() { printf "${YEL}⚠${RST} %s\n" "$*"; }
err()  { printf "${RED}✖${RST} %s\n" "$*" >&2; }

banner() {
  printf "${BLUE}"
  cat <<'EOF'
      ____                    _   _ ____
     / ___|  _   _ _____   _ | | | / ___|
     \___ \ | | | |_  / | | || | | \___ \
      ___) || |_| |/ /| |_| || |_| |___) |
     |____/  \__,_/___|\__,_| \___/|____/
EOF
  printf "${RST}${B}     Suzu-JS — APK Reverse-Engineering AI${RST}\n"
  printf "${GRY}     Telegram bot • Termux & server • all-in-one${RST}\n\n"
}

# ---- platform detection ---------------------------------------------------
IS_TERMUX=0
PLATFORM="linux"
if [ -n "${PREFIX:-}" ] && echo "$PREFIX" | grep -q "com.termux"; then
  IS_TERMUX=1
  PLATFORM="termux"
fi

SUDO=""
if [ "$IS_TERMUX" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
fi

# Where the project is installed.
if [ "$IS_TERMUX" -eq 1 ]; then
  INSTALL_DIR="${SUZU_INSTALL_DIR:-$HOME/script-js}"
  BIN_DIR="$PREFIX/bin"
else
  INSTALL_DIR="${SUZU_INSTALL_DIR:-$HOME/script-js}"
  BIN_DIR="/usr/local/bin"
fi

banner
say "Persekitaran dikesan: ${B}${PLATFORM}${RST}"
say "Direktori pemasangan: ${B}${INSTALL_DIR}${RST}"

# ---- package installation -------------------------------------------------
install_termux() {
  say "Mengemaskini pakej Termux…"
  pkg update -y >/dev/null 2>&1 || true
  say "Memasang pakej teras (node, java, apktool, aapt, dll)…"
  # apksigner/zipalign come from the 'apksigner'/'android-tools' packages.
  pkg install -y \
    nodejs-lts openjdk-17 apktool aapt aapt2 dx ecj \
    git curl unzip zip file binutils openssh termux-api \
    || pkg install -y nodejs openjdk-17 apktool aapt git curl unzip zip file binutils openssh

  # zipalign / apksigner ship in the android-tools package on Termux.
  pkg install -y apksigner 2>/dev/null || true
  pkg install -y zipalign 2>/dev/null || true
}

install_debian() {
  say "Mengemaskini apt…"
  $SUDO apt-get update -y >/dev/null 2>&1 || true
  say "Memasang pakej teras…"
  $SUDO apt-get install -y \
    ca-certificates curl gnupg git unzip zip file binutils \
    openjdk-17-jre-headless apktool aapt zipalign apksigner \
    openssh-server python3 || true

  # Node.js: prefer an existing >=18; otherwise install NodeSource 20.x.
  if ! have_node18; then
    say "Memasang Node.js 20.x (NodeSource)…"
    # Download then run the setup script. Piping straight into `$SUDO -E bash -`
    # breaks when running as root (empty $SUDO leaves a stray `-E`), so use a
    # temp file and run it with or without sudo explicitly.
    local setup="/tmp/nodesource_setup_20.sh"
    if curl -fsSL https://deb.nodesource.com/setup_20.x -o "$setup"; then
      if [ -n "$SUDO" ]; then $SUDO -E bash "$setup"; else bash "$setup"; fi
      $SUDO apt-get install -y nodejs || true
      rm -f "$setup"
    else
      warn "Gagal memuat turun skrip NodeSource."
    fi
  fi
}

have_node18() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 18 ]
}

if [ "$IS_TERMUX" -eq 1 ]; then
  install_termux
else
  install_debian
fi

# ---- verify node ----------------------------------------------------------
if ! have_node18; then
  err "Node.js >= 18 tidak dijumpai selepas pemasangan."
  if [ "$IS_TERMUX" -eq 1 ]; then
    err "Cuba: pkg install nodejs-lts"
  else
    err "Pasang Node 18+ secara manual, kemudian jalankan semula install.sh"
  fi
  exit 1
fi
ok "Node.js $(node -v) sedia."

# ---- jadx (optional but recommended) -------------------------------------
install_jadx() {
  if command -v jadx >/dev/null 2>&1; then ok "jadx sudah ada."; return; fi
  say "Memasang jadx…"
  local JADX_VER="1.5.0"
  local url="https://github.com/skylot/jadx/releases/download/v${JADX_VER}/jadx-${JADX_VER}.zip"
  local tmp; tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/jadx.zip" 2>/dev/null; then
    local dest
    if [ "$IS_TERMUX" -eq 1 ]; then dest="$PREFIX/opt/jadx"; else dest="/opt/jadx"; fi
    $SUDO mkdir -p "$dest"
    $SUDO unzip -oq "$tmp/jadx.zip" -d "$dest"
    $SUDO ln -sf "$dest/bin/jadx" "$BIN_DIR/jadx" 2>/dev/null || true
    $SUDO ln -sf "$dest/bin/jadx-gui" "$BIN_DIR/jadx-gui" 2>/dev/null || true
    ok "jadx ${JADX_VER} dipasang."
  else
    warn "Gagal memuat turun jadx (lewatkan). Boleh pasang manual kemudian."
  fi
  rm -rf "$tmp"
}
install_jadx || true

# ---- dex2jar (optional) ---------------------------------------------------
install_dex2jar() {
  if command -v d2j-dex2jar >/dev/null 2>&1; then ok "dex2jar sudah ada."; return; fi
  say "Memasang dex2jar…"
  local VER="2.4"
  local url="https://github.com/pxb1988/dex2jar/releases/download/v${VER}/dex-tools-v${VER}.zip"
  local tmp; tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/d2j.zip" 2>/dev/null; then
    local dest
    if [ "$IS_TERMUX" -eq 1 ]; then dest="$PREFIX/opt/dex2jar"; else dest="/opt/dex2jar"; fi
    $SUDO mkdir -p "$dest"
    $SUDO unzip -oq "$tmp/d2j.zip" -d "$dest"
    # The zip extracts to dex-tools-vX.Y/ — find the d2j-dex2jar.sh
    local sh
    sh="$(find "$dest" -name 'd2j-dex2jar.sh' | head -n1 || true)"
    if [ -n "$sh" ]; then
      $SUDO chmod +x "$(dirname "$sh")"/*.sh 2>/dev/null || true
      $SUDO ln -sf "$sh" "$BIN_DIR/d2j-dex2jar" 2>/dev/null || true
      ok "dex2jar ${VER} dipasang."
    fi
  else
    warn "Gagal memuat turun dex2jar (lewatkan)."
  fi
  rm -rf "$tmp"
}
install_dex2jar || true

# ---- fetch / update the project ------------------------------------------
# If we're already inside a clone (install.sh next to package.json), use it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"suzu-js"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  INSTALL_DIR="$SCRIPT_DIR"
  ok "Menggunakan salinan projek di ${INSTALL_DIR}"
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "Mengemaskini projek sedia ada…"
    git -C "$INSTALL_DIR" pull --ff-only || warn "git pull gagal (teruskan)."
  else
    say "Mengklon projek ke ${INSTALL_DIR}…"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
fi

# ---- link the `suzu` command ---------------------------------------------
chmod +x "$INSTALL_DIR/bin/suzu" 2>/dev/null || true
if [ -w "$BIN_DIR" ] || [ -n "$SUDO" ]; then
  $SUDO ln -sf "$INSTALL_DIR/bin/suzu" "$BIN_DIR/suzu" 2>/dev/null \
    && ok "Perintah 'suzu' dipasang di $BIN_DIR/suzu" \
    || warn "Tidak dapat membuat symlink di $BIN_DIR."
fi
if ! command -v suzu >/dev/null 2>&1; then
  warn "Tambah ke PATH atau guna: node $INSTALL_DIR/bin/suzu"
fi

# ---- debug keystore -------------------------------------------------------
DATA_DIR="${SUZU_DATA_DIR:-$HOME/.suzu-js}"
KS_DIR="$DATA_DIR/keystores"
KS="$KS_DIR/debug.keystore"
mkdir -p "$KS_DIR" "$DATA_DIR/users" "$DATA_DIR/logs"
if [ ! -f "$KS" ]; then
  if command -v keytool >/dev/null 2>&1; then
    say "Menjana debug keystore…"
    keytool -genkeypair -v -keystore "$KS" -storepass android -keypass android \
      -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1 \
      && ok "Debug keystore dibuat: $KS" \
      || warn "Gagal menjana keystore (keytool ralat)."
  else
    warn "keytool tidak dijumpai — keystore tidak dibuat. Pasang JDK penuh jika perlu sign APK."
  fi
else
  ok "Debug keystore sudah ada."
fi

# ---- first-time config ----------------------------------------------------
ENV_FILE="$DATA_DIR/.env"
echo
if [ ! -f "$ENV_FILE" ]; then
  say "Menjalankan konfigurasi pertama (boleh diulang dengan: suzu config)…"
  if [ -t 0 ]; then
    node "$INSTALL_DIR/bin/suzu" config || warn "Konfigurasi dilewatkan."
  else
    # Non-interactive install (piped). Write a template the user can edit.
    cat > "$ENV_FILE" <<EOF
TELEGRAM_BOT_TOKEN=
AI_API_BASE_URL=https://api.cybersecdev.cloud/v1
AI_API_KEY=
AI_DEFAULT_MODEL=fiq/qwen3.6-plus
TELEGRAM_ALLOWED_USER_IDS=
EOF
    chmod 600 "$ENV_FILE"
    warn "Pemasangan tanpa terminal: sunting $ENV_FILE atau jalankan 'suzu config'."
  fi
fi

echo
ok "Siap! Suzu-JS telah dipasang."
printf "${GRY}────────────────────────────────────────────${RST}\n"
echo "  Konfigurasi : suzu config"
echo "  Mula bot    : suzu start      (latar belakang)"
echo "  Foreground  : suzu run"
echo "  Status      : suzu status"
echo "  Log         : suzu logs -f"
echo "  Henti       : suzu stop"
printf "${GRY}────────────────────────────────────────────${RST}\n"
