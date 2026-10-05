# Rill versioning

Rill's current signed public release is version `1.0.3`. This source branch
targets the next maintenance release, `1.0.4`. Do not change download links to
`1.0.4` until its signed, notarized artifact has passed release verification.

Published versions follow semantic versioning:

- patch (`1.0.4`): compatible fixes and small refinements after 1.0.3
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
