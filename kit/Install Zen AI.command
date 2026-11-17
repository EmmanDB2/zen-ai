#!/bin/bash
# Installs Zen AI into Zen Browser (macOS). Double-click it, or in Terminal:
#   sh "Install Zen AI.command"            install, or update / repair
#   sh "Install Zen AI.command" --remove   take Zen AI out again
# Run it again after every Zen update: updates remove the loader from Zen.app.
#
# Env (for testing): ZEN_APP, ZEN_SUPPORT, ZEN_CACHE, ZEN_PROFILE,
# ZEN_PROCESS (the process name to wait for), ZENAI_CLAUDE_PLACES, ZENAI_YES=1
# (answer yes), ZENAI_NO_OPEN=1 (don't open Zen or System Settings)
set -u

KIT="$(cd "$(dirname "$0")" && pwd)"
FILES="$KIT/files"
ZEN_APP="${ZEN_APP:-/Applications/Zen.app}"
RES="$ZEN_APP/Contents/Resources"
ZEN_SUPPORT="${ZEN_SUPPORT:-$HOME/Library/Application Support/zen}"
ZEN_CACHE="${ZEN_CACHE:-$HOME/Library/Caches/zen}"
ZEN_PROCESS="${ZEN_PROCESS:-zen}"
MODE="install"
[ "${1:-}" = "--remove" ] && MODE="remove"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say() { printf '%s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*"; finish 1; }
finish() { say ""; [ -t 0 ] && [ -z "${ZENAI_YES:-}" ] && read -r -p "Press Return to close this window. " _; exit "${1:-0}"; }
# ask "Question?" → true for yes (Return means yes)
ask() {
  if [ -n "${ZENAI_YES:-}" ]; then say "$1 [Y/n] y"; return 0; fi
  printf '%s [Y/n] ' "$1"
  read -r answer || return 1
  case "$answer" in [nN]*) return 1 ;; *) return 0 ;; esac
}

printf '\033[1mZen AI installer\033[0m\n'

# Files that came from the internet are "quarantined"; ours are plain files
xattr -dr com.apple.quarantine "$KIT" 2>/dev/null || true
for f in "$FILES/zen-ai-chat.uc.js" "$FILES/fx-autoconfig/program/config.js" "$FILES/fx-autoconfig/program/defaults/pref/config-prefs.js" "$FILES/fx-autoconfig/profile/chrome/utils/boot.sys.mjs"; do
  [ -f "$f" ] || fail "This folder is missing ${f#$KIT/}. Unzip the whole kit again and run the installer from inside it."
done

# --- 1. Zen and its profile ---------------------------------------------------
bold "1. Zen"
[ -d "$ZEN_APP" ] || fail "Zen isn't in Applications. Install it from https://zen-browser.app, open it once, then run this again."
say "Found $ZEN_APP"

# The profile Zen opens: profiles.ini's [Install…] Default=, else the Default=1 profile
find_profile() {
  local ini="$ZEN_SUPPORT/profiles.ini" p
  [ -f "$ini" ] || return 1
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in /*) ;; *) p="$ZEN_SUPPORT/$p" ;; esac
    [ -d "$p" ] && { printf '%s' "$p"; return 0; }
  done <<EOF
$(awk '/^\[/ { sec = $0 } sec ~ /^\[Install/ && /^Default=/ { print substr($0, 9) }' "$ini")
EOF
  p="$(awk -F= '/^\[/ { if (path != "" && dflt) { print path; exit } sec = $0; path = ""; dflt = 0 }
                $1 == "Path" { path = substr($0, 6) } $1 == "Default" && $2 == "1" { dflt = 1 }
                END { if (path != "" && dflt) print path }' "$ini" | head -1)"
  [ -n "$p" ] || return 1
  case "$p" in /*) ;; *) p="$ZEN_SUPPORT/$p" ;; esac
  [ -d "$p" ] && printf '%s' "$p"
}
PROFILE="${ZEN_PROFILE:-$(find_profile)}"
if [ -z "$PROFILE" ] || [ ! -d "$PROFILE" ]; then
  fail "Couldn't find your Zen profile. Open Zen once (it makes one the first time), quit it, then run this again."
fi
say "Profile: $PROFILE"
STARTUP_CACHE="$ZEN_CACHE/Profiles/$(basename "$PROFILE")/startupCache"
MOD="$PROFILE/chrome/JS/zen-ai-chat.uc.js"

# Zen reads its scripts when it starts, so it has to be closed while we copy
quit_zen() {
  pgrep -xq "$ZEN_PROCESS" || return 0
  ask "Zen is open and needs to close for a moment. Quit Zen now?" || fail "Quit Zen (Cmd+Q), then run this again."
  osascript -e 'quit app "Zen"' >/dev/null 2>&1
  local i
  for i in $(seq 1 30); do pgrep -xq "$ZEN_PROCESS" || return 0; sleep 1; done
  fail "Zen didn't quit. Quit it yourself (Cmd+Q), then run this again."
}

if [ "$MODE" = "remove" ]; then
  bold "Removing Zen AI"
  quit_zen
  rm -f "$MOD" && say "Removed $MOD"
  rm -rf "$STARTUP_CACHE"
  say "Your chats stay in $PROFILE/zen-ai and files in ~/Documents/Claude Output; delete those too if you like."
  say "The loader (fx-autoconfig) is still in Zen.app and does nothing on its own. A Zen update removes it."
  finish 0
fi

# --- 2. Claude Code ---------------------------------------------------------
bold "2. Claude Code"
say "Zen AI chats through Claude Code, signed in with your own Claude account (Pro or Max)."
CLAUDE_PLACES="${ZENAI_CLAUDE_PLACES:-/opt/homebrew/bin/claude /usr/local/bin/claude $HOME/.claude/local/claude $HOME/.local/bin/claude $HOME/.npm-global/bin/claude $HOME/.bun/bin/claude $HOME/.volta/bin/claude}"
find_claude() {
  local p
  for p in $([ -z "${ZENAI_CLAUDE_PLACES:-}" ] && command -v claude 2>/dev/null) $CLAUDE_PLACES; do
    [ -x "$p" ] && "$p" --version 2>/dev/null | grep -qi "claude code" && { printf '%s' "$p"; return 0; }
  done
  return 1
}
CLAUDE="$(find_claude)"
if [ -z "$CLAUDE" ]; then
  say "Claude Code isn't installed."
  if ask "Install it now (Anthropic's installer from claude.ai)?"; then
    curl -fsSL https://claude.ai/install.sh | bash || say "The installer didn't finish."
    CLAUDE="$(find_claude)"
  fi
fi
if [ -z "$CLAUDE" ]; then
  say "Zen AI is installed anyway, but chats won't start until Claude Code is."
  say "Get it from https://claude.com/claude-code, then run this installer again."
else
  say "Found $("$CLAUDE" --version 2>/dev/null | head -1) at $CLAUDE"
  STATUS="$("$CLAUDE" auth status 2>/dev/null)"
  if printf '%s' "$STATUS" | grep -q '"loggedIn": *true'; then
    say "Signed in."
  elif printf '%s' "$STATUS" | grep -q '"loggedIn"'; then
    say "Claude Code isn't signed in yet."
    if ask "Sign in now? A browser window opens; sign in with your Claude account."; then
      "$CLAUDE" auth login || say "Sign-in didn't finish. Later, in Terminal: claude auth login"
    else
      say "Later, in Terminal: claude auth login"
    fi
  else
    say "(Couldn't tell whether it's signed in. If chats say you're logged out, run: claude auth login)"
  fi
fi

# --- 3. The loader, inside Zen.app --------------------------------------------
bold "3. Loader (fx-autoconfig), so Zen runs Zen AI"
quit_zen
FX="$FILES/fx-autoconfig"
if cmp -s "$FX/program/config.js" "$RES/config.js" && cmp -s "$FX/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js"; then
  say "Already in Zen.app."
elif cp "$FX/program/config.js" "$RES/config.js" 2>/dev/null && mkdir -p "$RES/defaults/pref" && cp "$FX/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js" 2>/dev/null; then
  say "Put into Zen.app."
else
  [ -z "${ZENAI_NO_OPEN:-}" ] && open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles" 2>/dev/null
  fail "macOS didn't let Terminal add the loader to Zen.app.
In the System Settings window that just opened (Privacy & Security → App Management),
turn on Terminal, then run this installer again."
fi

# --- 4. Zen AI, in your profile -----------------------------------------------
bold "4. Zen AI"
UTILS="$PROFILE/chrome/utils"
mkdir -p "$PROFILE/chrome/JS"
if [ -d "$UTILS" ] && ! diff -rq "$FX/profile/chrome/utils" "$UTILS" >/dev/null 2>&1; then
  BACKUP="$UTILS.before-zen-ai-$(date +%Y%m%d-%H%M%S)"
  mv "$UTILS" "$BACKUP" && say "Kept your old loader files in $BACKUP"
fi
if [ ! -d "$UTILS" ]; then
  cp -R "$FX/profile/chrome/utils" "$UTILS" || fail "Couldn't copy the loader into $UTILS"
fi
cp "$FILES/zen-ai-chat.uc.js" "$MOD" || fail "Couldn't copy Zen AI into $MOD"
say "Installed $MOD"
# Zen keeps compiled scripts in a cache: clear it so this version loads
rm -rf "$STARTUP_CACHE"

bold "Done!"
say "Open Zen and press Cmd+E to chat about the page you're on."
say "The first time Zen AI saves a file, macOS asks about your Documents folder: click Allow."
say "After a Zen update, if Cmd+E stops working, run this installer again."
if [ -z "${ZENAI_NO_OPEN:-}" ] && ask "Open Zen now?"; then open "$ZEN_APP"; fi
finish 0
