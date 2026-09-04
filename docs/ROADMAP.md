# Rill roadmap

The next releases should favor reliability and portability over adding more
controls to the main screen.

## Reliability

- Add a durable transaction journal, parent-directory synchronization, and
  cross-process locking for recovery from a process or power loss in the narrow
  interval between multi-file commits.
- Stream or range-load very large PDFs instead of transferring the complete
  file through one desktop IPC response.
- Add import progress, cancellation, retry, and a clear list of files that were
  skipped or rolled back.
- Add a Library Health Check that can detect missing PDFs, orphaned notes,
  duplicate identities, interrupted transactions, and cloud placeholders before
  offering a repair.
- Add an in-app update check that never installs an update without confirmation.

## Data portability

- Store citation presets and reference order in a versioned library settings
  file instead of browser-local storage so they move with the library.
- Export a NotebookLM-ready folder containing selected source PDFs, one concise
  Markdown note per paper, stable titles, and an index manifest. Uploading to a
  third-party service must remain an explicit user action.
- Define a migration path for Windows and a universal macOS build after the
  local-file and translation boundaries are separated from macOS-only code.

## Maintainability

- Split the large desktop application component into Library, References,
  Overview, Settings, and persistence modules with focused tests.
- Split the Rust library backend into path policy, index, import, notes,
  annotations, metadata lookup, Trash, and migration modules.
- Add a reproducible build script and recorded checksum for the bundled Swift
  translation helper instead of relying on a prebuilt sidecar alone.
- Keep the Web edition frozen until the macOS library and reader contracts are
  stable enough to share without changing the storage model.
