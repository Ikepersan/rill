# Changelog

## Unreleased

Target version: `1.0.4`. The signed public download remains `1.0.3` until
Developer ID signing, Apple notarization, and release verification are complete.

### Improved

- Removed Obsidian-specific connection checks, setup screens, and launch actions.
  Markdown notes, PDF annotation persistence, and external-edit conflict
  protection remain independent of any external editor.
- Added a PDF-only context menu for right-click and macOS Control-click, with
  selection copy, text annotations, search, and opening in Preview.
- Loaded PDF page geometry on demand while retaining exact page CropBoxes and
  preloading the pages needed by saved annotations and cross-page selections.
- Deferred outline and thumbnail work until the main PDF engine opens, and
  reused unchanged thumbnail components during reader updates.
- Avoided reconverting and resending annotation snapshots when only their save
  status changes; rollback revisions still update the PDF engine.
- Synced the containing directory after atomic local-library file replacements so
  note, index, annotation, and configuration filenames survive power loss more
  reliably.

### Fixed

- Kept delayed translation results from replacing newer edits or another selected
  paper, and preserved the latest Markdown revision acknowledgement.
- Released the busy state after batch reading-status, reference, and tag updates
  while retaining partial-save failure reporting.
- Coalesced repeated macOS focus events into one non-blocking library refresh so
  returning from another application does not queue overlapping full-library scans.

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
