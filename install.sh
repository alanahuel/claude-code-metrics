#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# claude-code-metrics — installer for Linux and macOS.
#
# Installs the two zero-dependency Python tools (claude-usage, claude-metrics)
# into ~/.local/bin, seeds the local SQLite history, and sets up a background
# scheduler so ingest/snapshot keep running (systemd user timers on Linux,
# launchd agents on macOS).
#
#   ./install.sh                  core install + autostart
#   ./install.sh --no-autostart   just the CLIs, no background scheduler
#   ./install.sh --waybar         also print the waybar wiring instructions
#   ./install.sh --astro          also build + run the optional Astro dashboard
#   ./install.sh --uninstall      remove tools + scheduler (KEEPS your data)
#
# Everything is local. No data ever leaves your machine. See docs/SECURITY.md.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${CLAUDE_METRICS_BIN:-$HOME/.local/bin}"
DASH_DIR="$HOME/.local/share/claude-code-metrics/dashboard-astro"

DO_AUTOSTART=1
DO_WAYBAR=0
DO_ASTRO=0
DO_UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --no-autostart) DO_AUTOSTART=0 ;;
    --waybar)       DO_WAYBAR=1 ;;
    --astro)        DO_ASTRO=1 ;;
    --uninstall)    DO_UNINSTALL=1 ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=macos ;;
  *) die "Unsupported OS '$(uname -s)'. On Windows use install.ps1 (PowerShell)." ;;
esac

# ── Uninstall ─────────────────────────────────────────────────────────────
uninstall() {
  say "Uninstalling claude-code-metrics (your data in ~/.local/share and ~/.config is kept)…"
  if [ "$OS" = linux ] && command -v systemctl >/dev/null 2>&1; then
    for u in claude-metrics-snapshot.timer claude-metrics-ingest.timer claude-metrics-dashboard.service; do
      systemctl --user disable --now "$u" 2>/dev/null || true
    done
    rm -f "$HOME"/.config/systemd/user/claude-metrics-*.{service,timer}
    systemctl --user daemon-reload 2>/dev/null || true
  elif [ "$OS" = macos ]; then
    for l in com.claude-metrics.ingest com.claude-metrics.snapshot; do
      launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/$l.plist" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$l.plist"
    done
  fi
  rm -f "$BIN_DIR/claude-usage" "$BIN_DIR/claude-metrics"
  rm -f "$HOME/.local/share/applications/claude-metrics.desktop"
  say "Done. To also delete your history:  rm -rf ~/.local/share/claude-metrics ~/.config/claude-usage"
  exit 0
}
[ "$DO_UNINSTALL" = 1 ] && uninstall

# ── Prerequisites ─────────────────────────────────────────────────────────
PY="$(command -v python3 || true)"
[ -n "$PY" ] || die "python3 not found. Install Python 3.8+ and re-run."
"$PY" - <<'EOF' || die "Python 3.8+ required."
import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)
EOF
say "Using $("$PY" --version 2>&1) at $PY"

# ── Install the CLIs ──────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
install -m 0755 "$REPO/bin/claude-usage"   "$BIN_DIR/claude-usage"
install -m 0755 "$REPO/bin/claude-metrics" "$BIN_DIR/claude-metrics"
say "Installed claude-usage and claude-metrics into $BIN_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile:"
     warn "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# ── Seed the SQLite history ───────────────────────────────────────────────
say "Building the local history database (first ingest)…"
"$BIN_DIR/claude-metrics" ingest || warn "Ingest reported an issue (ok if you have no Claude Code transcripts yet)."

# ── Autostart ─────────────────────────────────────────────────────────────
setup_linux() {
  command -v systemctl >/dev/null 2>&1 || { warn "systemctl not found; skipping autostart. Add a cron job calling 'claude-metrics ingest' and 'snapshot' every 15 min."; return; }
  local ud="$HOME/.config/systemd/user"
  mkdir -p "$ud"
  install -m 0644 "$REPO"/platform/linux/systemd/claude-metrics-ingest.service   "$ud/"
  install -m 0644 "$REPO"/platform/linux/systemd/claude-metrics-ingest.timer     "$ud/"
  install -m 0644 "$REPO"/platform/linux/systemd/claude-metrics-snapshot.service "$ud/"
  install -m 0644 "$REPO"/platform/linux/systemd/claude-metrics-snapshot.timer   "$ud/"
  systemctl --user daemon-reload
  systemctl --user enable --now claude-metrics-ingest.timer claude-metrics-snapshot.timer
  say "systemd user timers enabled (ingest + snapshot, every 15 min)."
  warn "Tip: run 'loginctl enable-linger $USER' so timers run even when you're logged out."
}

setup_macos() {
  local la="$HOME/Library/LaunchAgents"
  mkdir -p "$la"
  for job in ingest snapshot; do
    sed "s|@BIN@|$BIN_DIR/claude-metrics|g" \
      "$REPO/platform/macos/com.claude-metrics.$job.plist.in" > "$la/com.claude-metrics.$job.plist"
    launchctl bootout "gui/$(id -u)/com.claude-metrics.$job" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$la/com.claude-metrics.$job.plist" 2>/dev/null \
      || launchctl load "$la/com.claude-metrics.$job.plist"
  done
  say "launchd agents loaded (ingest + snapshot, every 15 min)."
}

if [ "$DO_AUTOSTART" = 1 ]; then
  [ "$OS" = linux ] && setup_linux || true
  [ "$OS" = macos ] && setup_macos || true
else
  warn "Skipping autostart (--no-autostart). Schedule 'claude-metrics ingest' + 'snapshot' yourself."
fi

# ── Optional: Astro dashboard ─────────────────────────────────────────────
if [ "$DO_ASTRO" = 1 ]; then
  NODE="$(command -v node || true)"
  NPM="$(command -v npm || true)"
  if [ -z "$NODE" ] || [ -z "$NPM" ]; then
    warn "Node.js + npm not found; skipping the Astro dashboard. Install Node 18+ and re-run with --astro."
  else
    say "Building the Astro dashboard…"
    rm -rf "$DASH_DIR"; mkdir -p "$DASH_DIR"
    cp -R "$REPO"/dashboard-astro/. "$DASH_DIR/"
    ( cd "$DASH_DIR" && "$NPM" install --no-audit --no-fund && "$NPM" run build )
    if [ "$OS" = linux ] && command -v systemctl >/dev/null 2>&1; then
      sed -e "s|@NODE@|$NODE|g" -e "s|@DASHDIR@|$DASH_DIR|g" \
        "$REPO/platform/linux/systemd/claude-metrics-dashboard.service.in" \
        > "$HOME/.config/systemd/user/claude-metrics-dashboard.service"
      install -m 0644 "$REPO/platform/linux/claude-metrics.desktop" \
        "$HOME/.local/share/applications/claude-metrics.desktop" 2>/dev/null || true
      systemctl --user daemon-reload
      systemctl --user enable --now claude-metrics-dashboard.service
      say "Astro dashboard running at http://127.0.0.1:4319 (systemd service)."
    else
      say "Astro dashboard built. Run it with:  ( cd '$DASH_DIR' && HOST=127.0.0.1 PORT=4319 node dist/server/entry.mjs )"
    fi
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────
echo
say "Installed. Try it:"
echo "    claude-metrics today      # hourly spend/tokens for today"
echo "    claude-metrics week       # last 7 days"
echo "    claude-metrics dashboard  # zero-dependency HTML dashboard"
echo "    claude-usage show         # live limit windows (5h / 7d / Opus)"
if [ "$DO_WAYBAR" = 1 ] || [ "$OS" = linux ]; then
  echo
  say "waybar: copy the modules from platform/linux/waybar/config.snippet.jsonc into"
  echo "    ~/.config/waybar/config.jsonc, add them to a modules array, then: killall -SIGUSR2 waybar"
fi
