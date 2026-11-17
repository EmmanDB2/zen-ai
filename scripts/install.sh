#!/bin/bash
# Installs Zen AI into your Zen profile (macOS).
#
#   sh scripts/install.sh            copy dist/zen-ai-chat.uc.js into the profile
#   sh scripts/install.sh --link     link it instead, so new builds go live on restart
#
# Env: ZEN_PROFILE=/path/to/profile   (default: your "Default (release)" profile)
#      FX_AUTOCONFIG=~/fx-autoconfig  (to re-apply the loader after a Zen update)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILT="$ROOT/dist/zen-ai-chat.uc.js"
APP="/Applications/Zen.app/Contents/Resources"
FX="${FX_AUTOCONFIG:-$HOME/fx-autoconfig}"
MODE="copy"
[ "${1:-}" = "--link" ] && MODE="link"

say() { printf '%s\n' "$*"; }
[ -f "$BUILT" ] || { say "No dist/zen-ai-chat.uc.js yet. Run: npm run build"; exit 1; }

# 1. Find the profile
PROFILE="${ZEN_PROFILE:-}"
if [ -z "$PROFILE" ]; then
  for p in "$HOME/Library/Application Support/zen/Profiles/"*"Default (release)"; do
    [ -d "$p" ] && PROFILE="$p" && break
  done
fi
if [ -z "$PROFILE" ] || [ ! -d "$PROFILE" ]; then
  say "Couldn't find your Zen profile. In Zen, open about:support, copy the Profile Folder path, then run:"
  say "  ZEN_PROFILE=\"/that/path\" sh scripts/install.sh"
  exit 1
fi
say "Profile: $PROFILE"

# 2. The loader (fx-autoconfig): a part inside Zen.app (gone after every Zen update) and a part in the profile
if [ ! -f "$APP/config.js" ]; then
  say ""
  say "fx-autoconfig's loader isn't in Zen.app (normal after a Zen update)."
  if [ -d "$FX/program" ]; then
    printf 'Copy it from %s/program now? [y/N] ' "$FX"
    read -r answer
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
      if cp -R "$FX/program/." "$APP/"; then
        say "Loader restored."
      else
        say "Couldn't write into Zen.app. Give Terminal \"App Management\" in System Settings → Privacy & Security, then try again."
        exit 1
      fi
    fi
  else
    say "Get fx-autoconfig (github.com/MrOtherGuy/fx-autoconfig) and copy its program/ folder into $APP"
    say "(or set FX_AUTOCONFIG to where you cloned it, and run this again)."
  fi
fi
if [ ! -d "$PROFILE/chrome/utils" ]; then
  say ""
  say "fx-autoconfig's profile part is missing: copy its profile/chrome/utils folder to $PROFILE/chrome/utils"
  [ -d "$FX/profile/chrome/utils" ] && say "  cp -R \"$FX/profile/chrome/utils\" \"$PROFILE/chrome/\""
fi

# 3. The mod itself
mkdir -p "$PROFILE/chrome/JS"
TARGET="$PROFILE/chrome/JS/zen-ai-chat.uc.js"
rm -f "$TARGET"
if [ "$MODE" = "link" ]; then
  ln -s "$BUILT" "$TARGET"
  say "Linked $TARGET → $BUILT"
else
  cp "$BUILT" "$TARGET"
  say "Installed $TARGET"
fi

# 4. Zen caches scripts: clear the startup cache so the new version loads
CACHE="$HOME/Library/Caches/zen/Profiles/$(basename "$PROFILE")/startupCache"
if pgrep -xq zen; then
  say ""
  say "Zen is running: in Zen, open about:support and click \"Clear startup cache…\" (it restarts Zen)."
elif [ -d "$CACHE" ]; then
  rm -rf "$CACHE"
  say "Cleared the startup cache. Open Zen and press Cmd+E."
else
  say "Open Zen and press Cmd+E. (If the old version shows up, about:support → Clear startup cache.)"
fi
