# Rill

Rill is a local-first macOS application for managing medical papers. PDFs remain
in a user-selected local folder, while bibliographic metadata, reading notes,
annotations, and Obsidian-compatible Markdown stay alongside the library.

## Current preview

Version `0.8.0` is the current pre-release preview and includes:

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

Rill's visible reader uses its original toolbar, five-color selection menu and
Reading Notes UI. A patched, UI-free
build of Zotero Reader's mobile `View` is used only for PDF rendering,
structured characters, reading order and selection geometry. Rill remains the
single owner of annotation state, JSON and Markdown persistence. The fixed
upstream commit, audited patch and rebuild script are included in this source.
Ambiguous layouts keep the upstream reading order. If extracted lines and
selection rectangles form a high-confidence two-column layout,
`rillReadingOrderV2` applies a conservative left-column/right-column ordering.
Rill 0.8.0 is intended for free preview distribution with its corresponding source;
voluntary donations do not limit the freedoms granted by the GNU AGPLv3.

## Privacy

Rill library data is not stored in this repository. PDF files, `.rill` metadata,
Obsidian configuration, exported reference files, and local databases are
explicitly excluded by `.gitignore`.

Do not commit copyrighted papers, patient information, personal reading notes,
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

Run the desktop app in development with:

```bash
npm run desktop:dev
```

The Tauri backend is under `src-tauri/`; the React desktop interface is under
`desktop/`. The earlier web prototype remains under `app/` for reference.

Release numbering and the manifests that must stay aligned are documented in
[`docs/VERSIONING.md`](docs/VERSIONING.md).
