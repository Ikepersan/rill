# Rill

Rill is a local-first macOS application for organizing, reading, and citing
medical papers. PDFs remain in a folder you choose, while bibliographic
metadata, reading notes, annotations, and Obsidian-compatible Markdown stay
alongside your library.

## Download

**[Download Rill 1.0.0 for Apple silicon (DMG)](https://github.com/Ikepersan/rill/releases/download/v1.0.0/Rill_1.0.0_aarch64.dmg)**

Open the downloaded DMG and drag `Rill.app` into `Applications`.
The distribution is signed with a Developer ID certificate and notarized by
Apple.

[View the release notes and SHA-256 checksum](https://github.com/Ikepersan/rill/releases/tag/v1.0.0)

## Current release

Version `1.0.0` is the first stable public release and includes:

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
- safe three-way merging with Obsidian Markdown
- CSL citation styles, BibTeX, and Markdown reference export
- full-text search across PDF and Markdown content on macOS
- on-device English-to-Japanese translation using Apple's Translation framework,
  with automatic guidance to Language & Region when language data is missing

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

Rill 1.0.0 is distributed free of charge with corresponding source code under
the GNU AGPLv3. Voluntary donations do not limit the freedoms granted by the
license.

## Privacy

Rill library data is not stored in this repository. PDF files, `.rill` metadata,
Obsidian configuration, exported reference files, and local databases are
explicitly excluded by `.gitignore`.

Do not commit copyrighted papers, patient information, private reading notes,
API credentials, or an Obsidian Vault to this repository.

## Development

Requirements:

- macOS on Apple silicon
- Node.js `>=22.13.0`
- Rust and the Tauri prerequisites

```bash
npm install
npm run desktop:frontend:build
npm run desktop:build
```

Run the desktop application in development with:

```bash
npm run desktop:dev
```

The Tauri backend is in `src-tauri/`, and the React desktop interface is in
`desktop/`. The earlier web prototype remains in `app/` for reference.

Release numbering and the manifests that must stay aligned are documented in
[`docs/VERSIONING.md`](docs/VERSIONING.md).
