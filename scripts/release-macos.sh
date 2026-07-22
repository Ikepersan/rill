#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RILL_VERSION="$(cd "$PROJECT_ROOT" && node -p "require('./package.json').version")"
APP_PATH="$PROJECT_ROOT/src-tauri/target/release/bundle/macos/Rill.app"
DMG_PATH="$PROJECT_ROOT/src-tauri/target/release/bundle/dmg/Rill_${RILL_VERSION}_aarch64.dmg"
NOTARY_PROFILE="${RILL_NOTARY_PROFILE:-RillNotary}"

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "APPLE_SIGNING_IDENTITY が未設定です。Developer ID Application証明書名を設定してください。" >&2
  exit 2
fi

if ! security find-identity -p codesigning -v | grep -Fq "\"$APPLE_SIGNING_IDENTITY\""; then
  echo "指定した署名証明書がKeychainにありません: $APPLE_SIGNING_IDENTITY" >&2
  exit 3
fi

cd "$PROJECT_ROOT"

# Tauriの自動ノータライズ用環境変数は渡さず、下のnotarytool手順へ一本化する。
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
  -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH \
  APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
  npm exec tauri build -- --config src-tauri/tauri.release.conf.json --bundles app,dmg

codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# staplerはUnicodeを含むパスを正規化してファイルを見失う場合があるため、
# ノータライズ工程だけASCIIパスへ退避し、staple済みDMGを成果物へ戻す。
NOTARY_STAGE="$(mktemp -d /private/tmp/rill-notary.XXXXXX)"
STAGED_DMG="$NOTARY_STAGE/Rill_${RILL_VERSION}_aarch64.dmg"
cleanup_notary_stage() {
  [[ ! -f "$STAGED_DMG" ]] || rm -f "$STAGED_DMG"
  [[ ! -d "$NOTARY_STAGE" ]] || rmdir "$NOTARY_STAGE"
}
trap cleanup_notary_stage EXIT
cp "$DMG_PATH" "$STAGED_DMG"

xcrun notarytool submit "$STAGED_DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$STAGED_DMG"
xcrun stapler validate "$STAGED_DMG"
spctl -a -vv --type open --context context:primary-signature "$STAGED_DMG"
cp "$STAGED_DMG" "$DMG_PATH"
cleanup_notary_stage
trap - EXIT

echo "配布用DMGを作成しました: $DMG_PATH"
