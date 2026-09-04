# Zotero Reader / PDF.js Engine Analysis Notes

> **About the Rill 0.8.0 implementation:** This document is a historical
> development analysis. Rill 0.8.0 bundles a modified PDF text-selection engine
> derived in part from Zotero Reader and distributed under the GNU AGPLv3. It
> does not use Zotero Reader's presentation UI. The application shell, Reading
> Notes, annotation management, and Markdown persistence are implemented by
> Rill.

## Purpose

Break the implementation down by capability so that Rill can reproduce Zotero
Reader's high-quality text selection and annotation behavior while preserving
the Rill 0.7.8 layout, colors, Reading Notes, and local-storage model.

In this document, "reproduce" does not mean copying Zotero's interface or
trademarks. It means analyzing the behavior and data flow of publicly available
source code and connecting those concepts to Rill's UI and persistence model.

The analysis is pinned to the following revisions:

- Zotero Reader: `c12c65e3f01414ae244f6102da4028c700cf6584`
- Zotero PDF.js fork: `f57fc80d1c07e4cdc50a767ae0b500b5272123b4`
- Rill PDF Viewer Lab: `codex/rill-zotero-reader-lab`

## Conclusion

Zotero's text selection is not effective merely because it uses PDF.js.

1. The PDF.js worker extracts per-glyph characters, rectangles, baselines,
   rotation, and font information.
2. Zotero's PDF.js fork structures those characters into lines, words, and
   paragraphs and assigns stable character offsets.
3. Reader converts pointer coordinates into character offsets and maintains a
   selection model separate from the browser's DOM Range.
4. During dragging, it renders a custom overlay of line rectangles generated
   from structured characters.
5. Only after selection is finalized does it synchronize a DOM selection for
   copying and accessibility.
6. Annotations retain PDF coordinates derived from character offsets, allowing
   them to be restored to the same location after zooming or rerendering.

The key design is therefore the separation of text extraction, structuring,
logical selection, presentation, and persistence.

## Overall Architecture

```text
PDF bytes
  -> PDF.js worker / evaluator
      -> glyph extraction
      -> char geometry
  -> Zotero PDF.js module
      -> structured chars
      -> content region / isolated text
      -> links / citations / outline / page labels
  -> Reader PDFView
      -> pointer-to-PDF coordinates
      -> char-offset selection ranges
      -> custom selection overlay
      -> annotation commands
  -> AnnotationManager
      -> canonical in-memory state
      -> undo / redo
      -> debounced save / delete callbacks
  -> Host application
      -> annotation JSON
      -> Markdown notes
      -> Rill UI
```

## 1. PDF Text-Extraction Layer

Primary implementation locations:

- `pdf.js/src/core/evaluator.js`
- `pdf.js/src/core/module/module.js`
- `pdf.js/src/core/worker.js`
- `pdf.js/src/display/api.js`

### Character Data Produced from Glyphs

In addition to the standard `textContent.items[].str`, the Zotero fork adds a
`chars` collection to each item. Each character contains approximately the
following information:

```ts
type RawChar = {
  c: string;          // Display/search character normalized with NFKD
  u: string;          // Character that preserves the original Unicode where possible
  rect: [number, number, number, number];
  fontSize: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  glyphWidth: number;
  baseline: number;
  rotation: 0 | 90 | 180 | 270;
  diagonal: boolean;
};
```

Rectangles are calculated from the PDF current transformation matrix and the
character ascent, descent, and advance. Type 3 fonts and vertical writing have
dedicated handling. Control characters are removed, and ligatures and combining
characters are normalized.

`Module.getPageData({ pageIndex })` ultimately returns:

```ts
type PageData = {
  partial: true;
  chars: StructuredChar[];
  overlays: Overlay[];
  viewBox: [number, number, number, number];
};
```

This API is an important boundary added between standard PDF.js and Zotero
Reader.

## 2. Character-Structuring Layer

Primary implementation locations:

- `pdf.js/src/core/module/structure.js`
- `getStructuredChars()`
- `split()`

### Deduplication

OCR and print-oriented PDFs can contain the same text layer more than once.
Duplicate characters are removed using a `character + rect` fingerprint.

### Line Recognition

The following properties of adjacent characters are evaluated to determine line
boundaries:

- baseline difference
- whether the character flow has returned to the beginning of a line
- changes in rotation
- overlap of rectangles along the line direction
- extreme character height, such as a drop cap

Characters assigned to the same line are reordered in visual coordinates for
their rotation and then processed for bidirectional text.

### Word Recognition

The implementation uses an adaptive spacing threshold derived from Xpdf. Rather
than relying on a fixed pixel distance, it calculates the threshold from average
font size, gaps between adjacent characters, and the distribution of explicit
spaces.

Each character then receives the following flags:

- `wordBreakAfter`
- `spaceAfter`
- `lineBreakAfter`
- `paragraphBreakAfter`

### Paragraph Recognition

Paragraph boundaries are inferred from line spacing, line height, dominant
fonts, indentation, and vertical relationships. Boundaries created by
indentation are preserved, while accidental single-line paragraphs are merged
back into the preceding paragraph.

### Hyphenation

A dash or hyphen at the end of a line is marked `ignorable`, preventing quoted
text from splitting a word unnaturally.

### Line Rectangles

An `inlineRect` is generated in addition to each character's `rect`. Characters
on the same line share a common line height, which prevents the first line of a
highlight from having a different height or filled area than subsequent lines.

### Stable Offsets

After structuring, `offset` values are assigned sequentially from zero. These
offsets form the shared key for selection, search, annotations, and copying.

## 3. How Reading Order Actually Works

An important qualification is that `structure.js` reorders characters within a
line into visual order, but it does not completely reorder every line on a page
by geometrically detecting columns.

For PDFs where two-column selection works correctly, quality primarily comes
from the following combination:

- the PDF content stream itself is close to the intended reading order
- line and paragraph boundaries are attached to the character array
- selection advances through a continuous range of character offsets rather
  than across DOM rectangles
- headers, footers, and similar content are excluded from body selection as
  isolated text

Zotero is therefore not infallible when the source PDF has a broken text-stream
order. Rill could improve stability further by adding a helper layer that builds
a reading-order graph from columns and body-text blocks.

## 4. Body Region and Isolated Text

Primary implementation locations:

- `pdf.js/src/core/module/content-rect.js`
- `Module.getProcessedData()`
- Reader `applySelectionRangeIsolation()`

Similar lines appearing at the same height on neighboring pages are compared to
infer repeated headers and footers. Page numbers are also removed from the
candidates, and the bounding rectangle of the remaining body lines becomes the
body region.

Characters outside the body region receive `isolated = true`. If a selection
starts in the body, isolated characters are excluded; if it starts in a header
or similar region, body text is excluded. This suppresses the common failure in
which a two-column selection jumps into a DOI, journal name, or page number.

## 5. Selection Model

Primary implementation locations:

- `reader/src/pdf/selection.js`
- `reader/src/pdf/pdf-view.js`

### From Coordinates to Character Offsets

Pointer coordinates are converted into PDF coordinates, then the nearest
character is found by measuring the distance to every character rectangle. The
character's rotation and whether the pointer lies before or after its center
determine whether the caret belongs before or after that character.

### SelectionRange

```ts
type SelectionRange = {
  anchorOffset: number;
  headOffset: number;
  anchor?: boolean;
  head?: boolean;
  collapsed?: boolean;
  position: {
    pageIndex: number;
    rects: PdfRect[];
  };
  text: string;
  sortIndex?: string;
};
```

`anchorOffset` and `headOffset` are the canonical representation of a selection.
The same model works when the drag direction is reversed.

### Conversion to Line Rectangles

Characters in the selection are grouped at each `lineBreakAfter`, and their
`inlineRect` values are unioned into one rectangle per line. This prevents a
highlight from extending into the right margin and keeps line heights
consistent.

### Word, Line, and Keyboard Selection

- Double-click: extend through `wordBreakAfter`
- Triple-click: extend through `lineBreakAfter`
- Shift + Arrow: change the character offset
- Up/Down Arrow: move to the nearest character on an adjacent line
- Shift + Click: retain the existing anchor and update the head

### Multiple Pages

Each page has its own SelectionRange. Annotation positions are normalized into
`position.rects` and `position.nextPageRects`; text annotations currently combine
up to two adjacent pages into one annotation.

## 6. Why the Entire Page Does Not Turn Blue

Reader does not treat the browser's native selection as canonical while the
pointer is being dragged.

- `pdf-view.js` handles pointer and mouse events in the capture phase
- it updates `_selectionRanges`
- `page.js` draws selection rectangles in a custom annotation layer
- the normal `::selection` in `viewer.css` is transparent
- after selection is finalized, `setTextLayerSelection()` synchronizes the DOM
  Range

The DOM Range supports copying and accessibility; it does not determine the
visible selection shape.

## 7. Annotation Rendering

Primary implementation locations:

- `reader/src/pdf/page.js`
- `reader/src/pdf/lib/utilities.js`

The PDF canvas is left unchanged. A display list is drawn in a DOM overlay above
it.

- highlight: line rectangles + `mix-blend-mode: multiply`
- underline: a thin line placed at the line edge according to text rotation
- note: an SVG sticky-note icon
- image: a rectangular region
- ink: a path
- find result: search-result rectangles
- current selection: an independent selection color

Page coordinates are converted to display coordinates on every render, so
annotation positions survive zooming, rotation, spread mode, and rerendering.

## 8. Annotation State and Persistence

Primary implementation locations:

- `reader/src/common/annotation-manager.js`
- `reader/src/common/reader.js`

`AnnotationManager` is the sole canonical source of annotation state.

- add / update / delete
- color changes
- conversion between highlight and underline
- ordering by `sortIndex`
- undo / redo
- client-originated `setAnnotations` / `unsetAnnotations`
- saving through host callbacks after a one-second debounce, with a ten-second
  maximum delay

For deletion, it first applies the annotation as a null change in memory and
rerenders immediately, then calls the host's delete callback.

If both Reader and React are canonical in Rill, deletions or color changes can
remain on only one side. Commands must flow in one direction through Rill's
adapter, and the confirmed state returned through Reader callbacks must be
projected into the Rill store and JSON / Markdown.

## 9. In-PDF Search

Primary implementation location:

- `reader/src/pdf/pdf-find-controller.js`

The `StructuredChar.u` values for each page are concatenated and Unicode-
normalized for searching. A mapping is built at the same time so that positions
in the search string can be converted back into original character offsets.

Matches are converted from character offsets into PDF rectangles by
`getRangeRects()`. Search-result rendering and body-text selection therefore use
the same coordinate system.

Supported behavior includes:

- case sensitivity
- whole-word matching
- highlighting all matches
- next / previous navigation
- CJK character classes
- diacritical marks and NFKC-related normalization

## 10. Outline, Page Numbers, and Links

### Outline

The embedded PDF outline is read first. If none exists, an outline is inferred
from up to 100 pages using heading candidates, differences from the dominant
body font, size, numbering, and the range over which candidates occur.

### Page Labels

Page labels in PDF metadata take precedence. When necessary, printed page
numbers are inferred from sequences of Arabic or Roman numerals aligned at the
same location across neighboring pages.

### Links and Citations

In addition to regular links, in-text citations and bibliography candidates are
extracted as processed overlays. An initial Rill implementation can adopt only
regular links and leave citation-link analysis as an independent later feature.

## 11. Thumbnails and Spread Mode

Thumbnails are rendered lazily for only the required pages through a dedicated
single-lane queue. They are rendered at approximately double resolution for
HiDPI and progressively downscaled to reduce blur. Annotation changes rerender
only thumbnails for pages that have already been displayed.

Spread and scroll modes use the PDF.js event bus events `switchspreadmode` and
`switchscrollmode`. The Rill UI only needs to call this public adapter.

## 12. Automatic Scrolling

When the pointer moves more than 25 pixels beyond a viewer edge during
selection, requestAnimationFrame scrolling begins at a distance-proportional
speed of up to 500 pixels per second. Because selection state is retained as
character offsets, it does not disappear while scrolling.

## 13. Boundary Adopted by Rill

For the immediate term, the safest architecture is to isolate Zotero Reader and
the PDF.js fork as an AGPL-covered engine and connect them to the Rill UI through
a typed adapter.

```ts
interface RillPdfEngine {
  open(input: ArrayBuffer): Promise<DocumentInfo>;
  navigate(target: PageTarget | AnnotationTarget): Promise<void>;
  setZoom(command: "in" | "out" | "page-width"): void;
  setSpread(mode: "none" | "odd" | "even"): void;
  setTool(tool: RillTool): void;
  setAnnotations(snapshot: RillAnnotation[]): void;
  deleteAnnotations(ids: string[]): void;
  search(query: SearchQuery): AsyncIterable<SearchState>;
  subscribe(listener: (event: ReaderEvent) => void): () => void;
  destroy(): void;
}
```

React must not call private APIs such as `_primaryView` or `_render()` directly.
Only the adapter should absorb differences in upstream APIs.

## 14. Recommended Rill Modules

```text
reader-engine/
  document-adapter.ts
  page-data.ts
  selection-model.ts
  annotation-model.ts
  search-adapter.ts
  reader-events.ts
  zotero-engine-adapter.ts

reader-ui/
  RillReaderShell.tsx
  RillReaderToolbar.tsx
  RillNavigation.tsx
  RillPdfSurface.tsx
  RillSelectionMenu.tsx
  RillReadingNotes.tsx

reader-storage/
  annotation-repository.ts
  markdown-projection.ts
  obsidian-merge.ts
```

## 15. Additional Rill Reading-Order Layer

To improve documents whose source PDF text order is broken, an optional helper
layer can run after Zotero's structured-character processing.

1. Generate line rectangles.
2. Infer columns from horizontal bands of whitespace.
3. Classify full-width headings, body columns, footnotes, and captions as
   blocks.
4. Build directed "read next" edges between blocks.
5. Prefer the PDF content-stream order when its difference from geometric order
   is small.
6. Do not reorder low-confidence results; allow the user to correct the range.

This layer should be introduced behind a feature flag so that it does not
degrade Zotero-derived behavior.

## 16. License Boundary

Zotero Reader is licensed under the GNU AGPLv3. Zotero's PDF.js fork includes
components covered by multiple third-party licenses, including Mozilla and
Apache licenses.

Distributing a Rill PDF Viewer Lab build that incorporates this code requires,
at minimum, the following:

- provide recipients with the corresponding source
- bundle the AGPLv3 `COPYING` file and copyright notices
- preserve third-party `NOTICE` and `LICENSE` files
- identify modifications
- do not present Zotero's name, logo, or interface as Rill branding
- associate each distributed DMG with its corresponding commit or tag

Whether distribution is free or paid does not change the obligation to comply
with the AGPL. Accepting donations is not itself a problem, provided the freedom
of the distributed software is not restricted.

## 17. Integration Problems Identified in the Reader Lab

- Rill React state and Reader AnnotationManager both act as canonical state.
- Deletion calls several private APIs, temporarily desynchronizing the central
  overlay and right-hand notes.
- Some Rill toolbar actions reach directly into Reader's private view.
- Hiding or rearranging the upstream selection popup with CSS is fragile.
- `nextPageRects` supports only two pages, so Rill must define a policy for
  continuous annotations spanning three or more pages.

The resolution is to treat Reader as an almost-headless engine and unify
selection finalization, annotation creation, annotation changes, and annotation
deletion as `ReaderEvent` messages delivered to Rill.
