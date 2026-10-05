# Rill

Rill is a local-first macOS application for managing medical papers. PDFs remain
in a user-selected local folder, while bibliographic metadata, reading notes,
annotations, and plain Markdown files stay alongside the library. Reading and
note-taking do not require an external note application.

This source branch targets `1.0.4`. The signed public download is still
`1.0.3`; the changes described under **Upcoming 1.0.4** are not included in that
download yet.

## Download

**[Download Rill 1.0.3 for Apple silicon (DMG)](https://github.com/Ikepersan/rill/releases/download/v1.0.3/Rill_1.0.3_aarch64.dmg)**

Open the downloaded DMG and drag `Rill.app` into `Applications`.
The distribution is signed with a Developer ID certificate and notarized by
Apple.

[View the release notes and SHA-256 checksum](https://github.com/Ikepersan/rill/releases/tag/v1.0.3)

## Upcoming 1.0.4

- no Obsidian connection checks, Vault setup, or Obsidian launch actions
- unchanged Markdown note and PDF annotation storage, with external-edit conflict protection
- on-demand PDF page geometry and deferred outline/thumbnail work for a lighter reader startup
- right-click and macOS Control-click menus for copy, annotations, search, and opening in Preview
- coalesced library refreshes when returning to Rill
- translation results that do not overwrite newer edits or a different selected paper
- batch actions that always release their busy state and retain save-failure reporting
- more durable atomic local-file replacements

Version `1.0.4` is not a public distributable yet. The download remains
`1.0.3` until Developer ID signing, Apple notarization, and release verification
are complete. Local ad hoc builds are for testing only.

## Current signed release

Version `1.0.3` includes everything in the first public
release, plus:

- folder renaming from the Library context menu
- drag-and-drop folder reparenting
- direct copying of selected PDF text without creating an annotation
- responsive startup and PDF import for cloud-backed local folders
- conservative DOI matching that validates Crossref candidates by title, author, year, and journal
- safer handling for oversized, malformed, and same-named PDFs
- stronger library-boundary checks for synchronized folders
- lower reader memory use and lazy thumbnail rendering
- reliable retry and rollback when local saves fail

## Core features

Rill also includes:

- a native macOS menu bar with Settings, library actions, view shortcuts, and version Help
- a calmer Overview with refined typography, quieter empty states, and user-facing storage labels
- local PDF import, folder organization, and multi-paper move/delete actions
- recoverable Rill Trash with restore, Finder access, and confirmed permanent deletion
- Ctrl-click paper actions with nested folder selection and create-and-move
- batch Crossref/PubMed metadata retrieval for selected papers
- selection-free paper dragging between library folders
- bulk reading-status completion for selected papers
- bulk tagging and bulk reference removal in the References workspace
- persistent PDF text-selection preview while choosing an annotation style
- column-aware PDF selection that ignores unrelated text blocks and survives scrolling
- reading status, favorites, flags, and tags
- visible filters and sorting by date, year, title, author, status, or importance
- built-in PDF reader with search, outline, thumbnails, and spread view
- highlights, underline, strikeout, area capture, and reading notes
- safe three-way merging with externally edited Markdown
- CSL citation styles, BibTeX, and Markdown reference export
- full-text search across PDF and Markdown content on macOS
- on-device English-to-Japanese translation using Apple's Translation framework,
  with automatic guidance to Language & Region when language data is missing

## Storage and synchronized folders

Rill saves PDFs and notes to the local library folder you choose. Markdown
files remain under `Notes/` and can be opened manually in other editors.
Version `1.0.4` removes only the dedicated Obsidian integration, not Markdown
storage; existing `.obsidian` configuration is left untouched.

You can choose a Google Drive or iCloud Drive folder, but synchronization is
handled by the corresponding desktop service, not by Rill. Make files
available locally and let synchronization finish before opening the same
library on another Mac. A successful local save does not confirm a completed
cloud upload, and Rill does not coordinate simultaneous edits across Macs.

## PDF reader engine

Rill's visible reader uses its own toolbar, five-color selection menu, and
Reading Notes interface. A patched, UI-free build of Zotero Reader's mobile
`View` is used only for PDF rendering, structured characters, reading order,
and selection geometry. Rill remains the sole owner of annotation state and
JSON/Markdown persistence.

The pinned upstream commit, audited patch, and reproducible build script are
included in this repository. Ambiguous layouts retain the upstream reading
order. When extracted lines and selection rectangles form a high-confidence
two-column layout, `rillReadingOrderV2` applies a conservative left-column then
right-column order.

Rill is distributed free of charge with corresponding source code under the
GNU AGPLv3. Voluntary donations do not limit the freedoms granted by the license.

## Privacy

Rill library data is not stored in this repository. PDF files, `.rill` metadata,
Obsidian configuration, exported reference files, and local databases are
explicitly excluded by `.gitignore`.

Rill's core library and reading workflow are local-first. When the user
explicitly requests bibliographic lookup, the available title, DOI, author,
year, or journal query is sent to Crossref or PubMed to find a match. The PDF
and Reading Notes are not uploaded for that lookup. Translation uses Apple's
system Translation framework and may require macOS to download language data.

Do not commit copyrighted papers, patient information, personal reading notes,
API credentials, or an Obsidian Vault to this repository.

## Development

Requirements:

- macOS on Apple silicon
- Node.js `>=22.13.0`
- Rust and the Tauri prerequisites

```bash
npm ci
npm run desktop:frontend:build
npm run desktop:build
```

Run the desktop application in development with:

```bash
npm run desktop:dev
```

The Tauri backend is under `src-tauri/`; the React desktop interface is under
`desktop/`. The earlier web prototype remains under `app/` for reference.

Release numbering and the manifests that must stay aligned are documented in
[`docs/VERSIONING.md`](docs/VERSIONING.md).

Release changes are listed in [`CHANGELOG.md`](CHANGELOG.md).
Planned reliability and portability work is tracked in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

Security issues should be reported privately as described in
[`SECURITY.md`](SECURITY.md). Instructions for restoring the development
environment on another Mac are in
[`docs/HANDOFF_TO_ANOTHER_MAC.md`](docs/HANDOFF_TO_ANOTHER_MAC.md).
