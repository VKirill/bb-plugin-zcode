#!/bin/bash
# Installs the ZCode bridge on this Mac so BB (or you, from a terminal) can drive the ZCode desktop app.
#
#   scripts/install.sh [--bin-dir DIR] [--no-plugin] [--default-mode ask|auto|full] [--rewards-job] [--dry-run] [--uninstall]
#
# What it does (nothing outside your home folder, nothing inside /Applications/ZCode.app):
#   1. checks macOS, Python 3, Node 20+, the Swift compiler (Xcode Command Line Tools) and the ZCode app;
#   2. builds the accessibility helper zcax from native/zcax.swift;
#   3. copies zcbridge, zcax, zcode-acp, zcode-cli-acp (+ .mjs) to ~/.local/share/zcode-bridge and links the commands into --bin-dir
#      (default ~/.local/bin; BB's host daemon must have that folder on its PATH, or set the plugin's "Agent command" to the full path);
#   4. with --default-mode writes ~/.zcode-bridge/config.json (the mode `zcbridge send` uses when you name none);
#   5. with --rewards-job installs a LaunchAgent that claims ZCode's daily token banner (see README);
#   6. installs the BB plugin from this checkout unless --no-plugin or `bb` is missing.
# It never signs in, never reads ZCode's credentials, and never runs `zcode login`.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN_DIR="$HOME/.local/bin"
SHARE="$HOME/.local/share/zcode-bridge"
PLUGIN=1; DRY=0; UNINSTALL=0; REWARDS=0; DEFAULT_MODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --no-plugin) PLUGIN=0; shift ;;
    --default-mode) DEFAULT_MODE="$2"; shift 2 ;;
    --rewards-job) REWARDS=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
BIN_DIR="${BIN_DIR/#\~/$HOME}"

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

LABEL="pro.zcode-bridge.rewards"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$UNINSTALL" = 1 ]; then
  say "Uninstalling the ZCode bridge from $SHARE and $BIN_DIR"
  for c in zcbridge zcode-acp zcode-cli-acp zcax; do
    if [ -L "$BIN_DIR/$c" ] && [[ "$(readlink "$BIN_DIR/$c")" == "$SHARE"/* ]]; then run rm -f "$BIN_DIR/$c"; fi
  done
  if [ -f "$PLIST" ]; then run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; run rm -f "$PLIST"; fi
  run rm -rf "$SHARE"
  say "Done. ~/.zcode-bridge (state, logs) was left; delete it yourself if you want."
  exit 0
fi

# 1. requirements
[ "$(uname -s)" = "Darwin" ] || fail "this needs macOS: ZCode is driven through the macOS accessibility API."
APP=""
for p in /Applications/ZCode.app "$HOME/Applications/ZCode.app"; do [ -d "$p" ] && APP="$p" && break; done
[ -n "$APP" ] || fail "the ZCode app was not found in /Applications. Install it from https://zcode.z.ai, sign in once inside the app, then run this again."
say "ZCode app: $APP"
command -v python3 >/dev/null || fail "python3 is needed (macOS: xcode-select --install, or brew install python)."
command -v node >/dev/null || fail "node 20+ is needed for the ACP agent (brew install node)."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail "node 20+ is needed (found $(node -v))."
command -v swiftc >/dev/null || fail "swiftc is missing: run  xcode-select --install  to get the Command Line Tools, then run this again."

# 2. build the helper
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
say "Building zcax (accessibility helper)..."
run swiftc -O -o "$BUILD/zcax" "$SRC/native/zcax.swift"

# 3. install
say "Installing to $SHARE and linking into $BIN_DIR"
run mkdir -p "$SHARE" "$BIN_DIR"
for f in zcbridge zcode-acp zcode-acp.mjs zcode-cli-acp zcode-cli-acp.mjs; do run install -m 0755 "$SRC/bin/$f" "$SHARE/$f"; done
run install -m 0755 "$BUILD/zcax" "$SHARE/zcax"
for c in zcbridge zcode-acp zcode-cli-acp zcax; do
  if [ -e "$BIN_DIR/$c" ] && [ ! -L "$BIN_DIR/$c" ]; then
    say "  $BIN_DIR/$c exists and is not a link: moving it to $BIN_DIR/$c.bak"
    run mv "$BIN_DIR/$c" "$BIN_DIR/$c.bak"
  fi
  run ln -sfn "$SHARE/$c" "$BIN_DIR/$c"
done
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "  note: $BIN_DIR is not on your PATH here; add it, and make sure BB's host daemon sees it too (or set the plugin's \"Agent command\" to $BIN_DIR/zcode-acp).";; esac

# 4. default mode
if [ -n "$DEFAULT_MODE" ]; then
  case "$DEFAULT_MODE" in ask|auto|full) ;; *) fail "--default-mode is ask, auto or full";; esac
  CFG="$HOME/.zcode-bridge/config.json"
  if [ -e "$CFG" ]; then say "  $CFG exists: left as it is (set \"default_mode\" in it by hand)."
  else run mkdir -p "$HOME/.zcode-bridge"; if [ "$DRY" = 1 ]; then say "  [dry-run] write $CFG {\"default_mode\": \"$DEFAULT_MODE\"}"; else printf '{"default_mode": "%s"}\n' "$DEFAULT_MODE" > "$CFG"; fi; fi
fi

# 5. daily claim job
if [ "$REWARDS" = 1 ]; then
  say "Installing the daily-token claim job ($LABEL)"
  if [ "$DRY" = 1 ]; then say "  [dry-run] write $PLIST and load it"; else
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.zcode-bridge"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$SHARE/zcbridge</string><string>rewards</string><string>--scheduled</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$HOME/.zcode-bridge/rewards.log</string>
  <key>StandardErrorPath</key><string>$HOME/.zcode-bridge/rewards.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
fi

# 6. the BB plugin
if [ "$PLUGIN" = 1 ]; then
  if command -v bb >/dev/null; then
    say "Installing the BB plugin from $SRC"
    run bb plugin install "$SRC" --yes
  else
    say "bb is not on PATH: install the plugin later with  bb plugin install $SRC  (or from the BB Community marketplace)."
  fi
fi

cat <<MSG

Almost done. One thing only you can do: macOS must let the program that runs zcax control ZCode.
  System Settings > Privacy & Security > Accessibility, add and switch on:
    - your terminal app (for running zcbridge by hand), and
    - the program that runs BB's host daemon (find it with:  ps -axo comm | grep -i node ), for chats started from BB.
Keep the ZCode app open and signed in (sign in inside the app; this tool never logs in for you).

Check:   $BIN_DIR/zcbridge doctor
Try:     $BIN_DIR/zcbridge send --folder ~/some/project --prompt "Reply with OK" --wait
In BB:   Settings > Plugins > ZCode provider, then pick ZCode as the provider of a chat.
MSG
