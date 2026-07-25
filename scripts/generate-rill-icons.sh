#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
icons_dir="$repo_root/src-tauri/icons"
source_svg="$icons_dir/rill-meander.svg"
background_svg="$repo_root/src-tauri/images/dmg-background.svg"
background_png="$repo_root/src-tauri/images/dmg-background.png"
generated_dir=$(mktemp -d "${TMPDIR:-/tmp}/rill-icons.XXXXXX")
trap 'rm -rf "$generated_dir"' EXIT

if ! command -v sips >/dev/null 2>&1 || ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "This script requires macOS sips and rsvg-convert." >&2
  exit 1
fi

npm --prefix "$repo_root" exec tauri icon -- "$source_svg" --output "$generated_dir"

cp "$generated_dir/32x32.png" "$icons_dir/32x32.png"
cp "$generated_dir/64x64.png" "$icons_dir/64x64.png"
cp "$generated_dir/128x128.png" "$icons_dir/128x128.png"
cp "$generated_dir/128x128@2x.png" "$icons_dir/128x128@2x.png"
cp "$generated_dir/icon.png" "$icons_dir/512x512.png"
cp "$generated_dir/icon.icns" "$icons_dir/icon.icns"

sips -z 256 256 "$icons_dir/512x512.png" --out "$icons_dir/256x256.png" >/dev/null

rsvg-convert --width 1024 --height 1024 "$source_svg" --output "$icons_dir/1024x1024.png"
rsvg-convert --width 660 --height 400 "$background_svg" --output "$background_png"

echo "Generated Rill 32–1024 px PNG, ICNS, and DMG background assets"
