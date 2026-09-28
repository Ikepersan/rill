# Changelog

## Unreleased

### Improved

- Synced the containing directory after atomic local-library file replacements so
  note, index, annotation, and configuration filenames survive power loss more
  reliably.

### Fixed

- Avoided reporting an Obsidian Vault as connected after a Mac migration until
  that Vault is registered with Obsidian on the current Mac.
- Coalesced repeated macOS focus events into one non-blocking library refresh so
  returning from Obsidian does not queue overlapping full-library scans.

## 1.0.3

### Fixed

- Prevented background library rescans from interrupting normal work with a full-screen loading state.
- Reduced PDF reader memory use by removing an amplified byte copy, loading the reader only when needed, and rendering thumbnails lazily.
- Added limits for PDF size, page count, and area-capture canvases, with clearer errors for unsupported files.
- Kept unsaved paper edits recoverable and retried failed saves before the application closes.
- Made paper moves, Trash operations, and PDF Reader exit wait for pending paper or annotation saves.
- Rolled back reading status, reference, favorite, and flag changes when their local save fails.
- Prevented distinct PDFs with the same filename from sharing one note, identity, or annotation history.
- Hardened managed library paths against symbolic links that lead outside the selected library.
- Rejected malformed persisted annotation geometry before it reaches the PDF engine or Reading Notes.
- Updated PDF.js to a patched release, disabled PDF scripting and dynamic evaluation,
  and restricted PDF links to web and email schemes.

### Improved

- Preserved medical and scientific abbreviations when converting citation titles to sentence case.
- Split the PDF reader into an on-demand bundle for a lighter normal startup.
- Added a SHA-256 sidecar to the signed and notarized macOS release workflow.
- Added a public security-reporting policy, automated dependency updates, and
  dependency auditing to the macOS quality gate.
- Added an actual Apple Silicon application-bundle build to CI and made the
  release script reject dirty sources or mismatched submodules.
- Excluded common Apple signing-key and certificate exports from Git tracking.
- Standardized public development and release documentation in English.

### Release note

The distributable DMG must be built with a valid Developer ID Application identity, notarized by Apple, stapled, and verified. Ad hoc local builds are for testing only.
