#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RILL_VERSION="$(cd "$PROJECT_ROOT" && node -p "require('./package.json').version")"
APP_PATH="${1:-$PROJECT_ROOT/src-tauri/target/release/bundle/macos/Rill.app}"
DMG_PATH="${2:-$PROJECT_ROOT/src-tauri/target/release/bundle/dmg/Rill_${RILL_VERSION}_aarch64.dmg}"

echo "== Version =="
plutil -extract CFBundleShortVersionString raw "$APP_PATH/Contents/Info.plist"
plutil -extract CFBundleVersion raw "$APP_PATH/Contents/Info.plist"

echo "== Signature =="
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dvvv "$APP_PATH" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier|Signature|Runtime Version)="

echo "== Gatekeeper =="
spctl -a -vv "$APP_PATH"

if [[ -f "$DMG_PATH" ]]; then
  echo "== Staple =="
  CHECK_STAGE="$(mktemp -d /private/tmp/rill-release-check.XXXXXX)"
  CHECK_DMG="$CHECK_STAGE/Rill.dmg"
  cleanup_check_stage() {
    [[ ! -f "$CHECK_DMG" ]] || rm -f "$CHECK_DMG"
    [[ ! -d "$CHECK_STAGE" ]] || rmdir "$CHECK_STAGE"
  }
  trap cleanup_check_stage EXIT
  cp "$DMG_PATH" "$CHECK_DMG"
  xcrun stapler validate "$CHECK_DMG"
  cleanup_check_stage
  trap - EXIT
fi
