# Rill PDF selection engine provenance

- Upstream: `https://github.com/zotero/reader.git`
- Upstream commit: `c12c65e3f01414ae244f6102da4028c700cf6584`
- PDF.js fork commit: `f57fc80d1c07e4cdc50a767ae0b500b5272123b4`
- Patch: `patches/zotero-reader/0001-rill-headless-selection-engine.patch`
- Build command: `scripts/build_rill_pdf_engine.sh`
- License: GNU Affero General Public License v3.0; see `COPYING`
- PDF.js license: Apache License 2.0; see `pdf/LICENSE`

The bundled target uses the upstream mobile `View` as a PDF page, structured-character,
reading-order and selection-geometry engine. It does not bundle the upstream Reader UI
entry point, toolbar, selection popup, context menu or annotation sidebar.
