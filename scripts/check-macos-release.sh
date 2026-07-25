#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RILL_VERSION="$(cd "$PROJECT_ROOT" && node -p "require('./package.json').version")"
DMG_PATH="${1:-$PROJECT_ROOT/src-tauri/target/release/bundle/dmg/Rill_${RILL_VERSION}_aarch64.dmg}"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "検査するDMGが見つかりません: $DMG_PATH" >&2
  exit 2
fi

CHECK_STAGE="$(mktemp -d /private/tmp/rill-release-check.XXXXXX)"
CHECK_DMG="$CHECK_STAGE/Rill.dmg"
MOUNT_POINT="$CHECK_STAGE/mount"
mkdir "$MOUNT_POINT"
MOUNTED=0

cleanup_check_stage() {
  if [[ "$MOUNTED" -eq 1 ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
  [[ ! -f "$CHECK_DMG" ]] || rm -f "$CHECK_DMG"
  [[ ! -d "$MOUNT_POINT" ]] || rmdir "$MOUNT_POINT"
  [[ ! -d "$CHECK_STAGE" ]] || rmdir "$CHECK_STAGE"
}
trap cleanup_check_stage EXIT

cp "$DMG_PATH" "$CHECK_DMG"

echo "== DMG trust =="
xcrun stapler validate "$CHECK_DMG"
spctl -a -vv --type open --context context:primary-signature "$CHECK_DMG"

hdiutil attach "$CHECK_DMG" -readonly -nobrowse -mountpoint "$MOUNT_POINT" -quiet
MOUNTED=1
APP_PATH="$MOUNT_POINT/Rill.app"

if [[ ! -d "$APP_PATH" ]]; then
  echo "DMG内にRill.appがありません" >&2
  exit 3
fi

echo "== Version =="
APP_SHORT_VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP_PATH/Contents/Info.plist")"
APP_BUILD_VERSION="$(plutil -extract CFBundleVersion raw "$APP_PATH/Contents/Info.plist")"
printf '%s\n%s\n' "$APP_SHORT_VERSION" "$APP_BUILD_VERSION"
if [[ "$APP_SHORT_VERSION" != "$RILL_VERSION" || "$APP_BUILD_VERSION" != "$RILL_VERSION" ]]; then
  echo "DMG内アプリのバージョンがpackage.jsonと一致しません" >&2
  exit 4
fi

echo "== App signature =="
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dvvv "$APP_PATH" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier|Signature|Runtime Version)="
spctl -a -vv "$APP_PATH"

HELPER_PATH="$APP_PATH/Contents/MacOS/rill-translate"
if [[ -f "$HELPER_PATH" ]]; then
  echo "== Translation helper signature =="
  codesign --verify --strict --verbose=2 "$HELPER_PATH"
fi

echo "配布検査に合格しました: $DMG_PATH"
