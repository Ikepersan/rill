#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
upstream="$repo_root/vendor/zotero-reader"
patch_file="$repo_root/patches/zotero-reader/0001-rill-headless-selection-engine.patch"
output="$repo_root/desktop/public/rill-pdf-engine"
expected_reader_commit="c12c65e3f01414ae244f6102da4028c700cf6584"
expected_pdfjs_commit="f57fc80d1c07e4cdc50a767ae0b500b5272123b4"

git -C "$repo_root" submodule update --init --recursive vendor/zotero-reader

actual_reader_commit="$(git -C "$upstream" rev-parse HEAD)"
actual_pdfjs_commit="$(git -C "$upstream/pdfjs/pdf.js" rev-parse HEAD)"
if [[ "$actual_reader_commit" != "$expected_reader_commit" ]]; then
  echo "unexpected Zotero Reader commit: $actual_reader_commit" >&2
  exit 1
fi
if [[ "$actual_pdfjs_commit" != "$expected_pdfjs_commit" ]]; then
  echo "unexpected Zotero PDF.js commit: $actual_pdfjs_commit" >&2
  exit 1
fi

if ! git -C "$upstream" diff --quiet || ! git -C "$upstream" diff --cached --quiet; then
  echo "vendor/zotero-reader must be clean before applying the audited Rill patch" >&2
  exit 1
fi

cleanup() {
  git -C "$upstream" apply --reverse "$patch_file" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$upstream" apply --check "$patch_file"
git -C "$upstream" apply "$patch_file"
npm --prefix "$upstream" ci
npm --prefix "$upstream/pdfjs/pdf.js" ci
(
  cd "$upstream"
  PDFJS_CONFIG=mobile bash pdfjs/build
  ./node_modules/.bin/webpack --config-name rill
)

mkdir -p "$output"
rsync -a --delete --exclude '*.map' --exclude 'PROVENANCE.md' "$upstream/build/rill/" "$output/"
cp "$upstream/COPYING" "$output/COPYING"
mkdir -p "$output/pdf"
cp "$upstream/pdfjs/pdf.js/LICENSE" "$output/pdf/LICENSE"

echo "Rill PDF selection engine rebuilt from $(git -C "$upstream" rev-parse HEAD)"
