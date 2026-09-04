#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RILL_VERSION="$(cd "$PROJECT_ROOT" && node -p "require('./package.json').version")"
APP_PATH="$PROJECT_ROOT/src-tauri/target/release/bundle/macos/Rill.app"
DMG_PATH="$PROJECT_ROOT/src-tauri/target/release/bundle/dmg/Rill_${RILL_VERSION}_aarch64.dmg"
DMG_DIRECTORY="$(dirname "$DMG_PATH")"
DMG_FILENAME="$(basename "$DMG_PATH")"
CHECKSUM_FILENAME="Rill_${RILL_VERSION}_SHA256SUMS.txt"
CHECKSUM_PATH="$DMG_DIRECTORY/$CHECKSUM_FILENAME"
NOTARY_PROFILE="${RILL_NOTARY_PROFILE:-RillNotary}"

if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=normal)" ]]; then
  echo "The release worktree has uncommitted or untracked files. Commit or remove them before building a distributable." >&2
  exit 2
fi

SUBMODULE_STATUS="$(git -C "$PROJECT_ROOT" submodule status --recursive)"
if [[ -n "$SUBMODULE_STATUS" ]] && grep -Eq '^[-+U]' <<<"$SUBMODULE_STATUS"; then
  echo "One or more submodules are missing, conflicted, or checked out at a commit different from the release source." >&2
  exit 3
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "APPLE_SIGNING_IDENTITY is not set. Provide the full Developer ID Application identity." >&2
  exit 4
fi

if ! security find-identity -p codesigning -v | grep -Fq "\"$APPLE_SIGNING_IDENTITY\""; then
  echo "The requested signing identity is not available in the Keychain: $APPLE_SIGNING_IDENTITY" >&2
  exit 5
fi

if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --output-format json >/dev/null; then
  echo "The notarization Keychain profile is unavailable: $NOTARY_PROFILE" >&2
  exit 6
fi

cd "$PROJECT_ROOT"

# Keep notarization in the explicit notarytool flow below instead of letting Tauri submit implicitly.
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
  -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH \
  APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
  npm exec tauri build -- --config src-tauri/tauri.release.conf.json --bundles app,dmg

codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# stapler can lose a file when a path containing Unicode is normalized differently.
# Stage the DMG under an ASCII-only path, then copy the stapled artifact back.
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

(
  cd "$DMG_DIRECTORY"
  shasum -a 256 "$DMG_FILENAME" > "$CHECKSUM_FILENAME.rilltmp"
  mv "$CHECKSUM_FILENAME.rilltmp" "$CHECKSUM_FILENAME"
)

bash "$PROJECT_ROOT/scripts/check-macos-release.sh" "$DMG_PATH"

echo "Created the distributable DMG: $DMG_PATH"
echo "Created the SHA-256 checksum: $CHECKSUM_PATH"
