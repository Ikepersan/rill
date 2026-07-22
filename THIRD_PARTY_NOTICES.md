# Third-party notice for Rill 0.8.0

Rill includes a patched, UI-free build of Zotero
Reader's mobile `View` from commit
`c12c65e3f01414ae244f6102da4028c700cf6584`.

Zotero Reader is copyright Corporation for Digital Scholarship and is licensed
under the GNU Affero General Public License version 3. Its source is tracked as
the `vendor/zotero-reader` submodule. The audited patch is stored at
`patches/zotero-reader/0001-rill-headless-selection-engine.patch`, the build is
reproduced by `scripts/build_rill_pdf_engine.sh`, and the license text is
included at `desktop/public/rill-pdf-engine/COPYING`.

The Reader revision above pins the Zotero PDF.js fork at commit
`f57fc80d1c07e4cdc50a767ae0b500b5272123b4`. That PDF.js source is licensed
under the Apache License 2.0. Its source is tracked below
`vendor/zotero-reader/pdfjs/pdf.js`, and its license text is included at
`desktop/public/rill-pdf-engine/pdf/LICENSE` and in the macOS application bundle
as `licenses/PDFJS-APACHE-2.0.txt`.

The upstream source was modified for Rill on 2026-07-19. The modifications add
an external, UI-free selection bridge and a reproducible Rill engine build while
leaving the upstream copyright notices intact. The exact changes are provided
as the audited patch named above.

The upstream Reader toolbar, selection popup, context menu, annotation sidebar,
colors and product branding are not built into Rill. Rill provides its own visible
reader interface and annotation repository. Rill 0.8.0 is distributed under the
GNU Affero General Public License version 3 (AGPLv3) with corresponding source at
`https://github.com/Ikepersan/rill/tree/v0.8.0`. “Zotero” is used only to identify
the upstream project; it is not the product name or an indication of endorsement.
