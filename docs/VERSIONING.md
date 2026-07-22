# Rill versioning

Rill's current pre-release preview is version `0.8.0`. Version `1.0.0` is
reserved for the first public distribution after final polish, signing and
notarization are complete.

Published versions follow semantic versioning. Before 1.0, compatible preview
fixes use `0.8.x`:

- preview patch (`0.8.1`): compatible fixes and small refinements before 1.0
- patch (`1.0.1`): compatible fixes and small refinements after 1.0
- minor (`1.1.0`): compatible features
- major (`2.0.0`): changes that require a migration or materially alter the library format

The following files must always contain the same application version:

- `src-tauri/tauri.conf.json` (the version shown by macOS and Help)
- `src-tauri/Cargo.toml` and the Rill entry in `src-tauri/Cargo.lock`
- `package.json` and the root package entries in `package-lock.json`

Before creating a release tag, build the app and confirm that
`CFBundleShortVersionString`, `CFBundleVersion`, the DMG filename, and the Help
dialog all show the intended version. Do not reuse or move a published release
tag.
