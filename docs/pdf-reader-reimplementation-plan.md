# Rill PDF Reader Integration Plan

> **About the Rill 0.8.0 implementation:** This document is a historical
> development plan. Rill 0.8.0 bundles a modified PDF text-selection engine
> derived in part from Zotero Reader and distributed under the GNU AGPLv3. It
> does not use Zotero Reader's presentation UI. The application shell, Reading
> Notes, annotation management, and Markdown persistence are implemented by
> Rill.

## Completion Criteria

The following requirements must be met without changing Rill's appearance or
workflow:

- text can be selected naturally from the bottom of the left column to the top
  of the right column in a two-column document
- reverse selection from the top of the right column to the bottom of the left
  column produces the same text
- selection remains active across scrolling, zooming, and spread-mode changes
- the visible selection and quoted text in Reading Notes match
- deletion, color changes, and conversion to underline update the central view
  and right-hand notes at the same time
- in-PDF search, outline, thumbnails, and spread mode can be controlled from the
  Rill UI
- annotations are saved atomically to local JSON and Markdown
- Obsidian changes can be merged safely with a three-way merge

## Phase 0: Pin the Analysis Baseline

- pin the upstream commits
- associate the Reader Lab DMG, source commit, and third-party licenses
- prepare a list of private local fixtures, including pathological PDFs
- do not commit test PDFs or article text to GitHub

Completion gate: the same lab application can be reproduced from the same
source.

## Phase 1: Engine Adapter

`RillPdfReader.tsx` must use only the `RillPdfEngine` adapter and must not access
private upstream APIs directly.

Supported commands:

- open / close
- page navigation
- zoom
- spread / scroll mode
- search
- tool selection
- annotation snapshot
- annotation add / update / delete
- selection finalized
- document stats

Every event must include a monotonically increasing revision. An older
asynchronous save callback must never overwrite newer UI state.

Completion gate: the React component contains no `_primaryView`, `_render`, or
Reader-internal state names.

## Phase 2: One Canonical Annotation Store

Create an `AnnotationRepository` on the Rill side.

```text
User action
  -> engine command
  -> Reader event
  -> AnnotationRepository transaction
  -> React snapshot
  -> JSON atomic write
  -> Markdown projection
```

An annotation deletion must perform the following as one transaction:

1. remove the overlay from the engine
2. clear the selected annotation
3. remove it from the Rill store
4. update the right-hand notes
5. rename the JSON file into place through a temporary file
6. update the Highlights section in Markdown

If saving fails, display the failure in the UI and distinguish the in-memory
revision from the on-disk revision.

Completion gate: after deletion, the central overlay, right-hand notes, and
post-restart state all agree.

## Phase 3: Rill-Specific Selection UI

Do not display the upstream selection popup. Receive the finalized-selection
event and render Rill's popup with the following actions:

- highlight
- underline
- strikeout
- color
- add to notes
- copy

Strikeout should either extend Reader's base annotation model or remain a
Rill-specific type in the adapter. It must not be forced into an unrelated
upstream type.

Completion gate: no Zotero-specific labels, icons, or layouts appear on screen;
only Rill's interaction design remains.

## Phase 4: Reading-Order Improvements

Use Zotero's structured characters unchanged as the initial baseline. Then add
a `rillReadingOrderV2` feature flag.

### V2 Pipeline

1. Build Lines from StructuredChar values.
2. Remove duplicate lines, headers, footers, and page numbers.
3. Separate full-width regions from column regions.
4. Cluster column gaps.
5. Combine Lines into TextBlocks.
6. Infer paragraphs from font, indentation, spacing, and punctuation.
7. Topologically sort the block graph.
8. Measure edit distance from the original stream order and assign a confidence
   score.

For low-confidence PDFs, retain the original order rather than applying
automatic reordering.

Completion gate: for two-column fixtures, the visible range and the order of
quoted text agree.

## Phase 5: Search, Outline, and Thumbnails

### Search

- use the StructuredChar string and offset mapping
- draw the current match and all matches in the Rill overlay
- support Enter / Shift+Enter and the Up/Down buttons

### Outline

- prefer the native outline
- label an inferred outline as "Automatically generated"
- do not save inferred results into user data without permission

### Thumbnails

- use a single-lane queue that prioritizes the visible range
- render for HiDPI, then downscale progressively
- when annotations change, invalidate only pages that have already been
  rendered

Completion gate: a PDF of 100 or more pages does not delay the initial view, and
thumbnails render lazily as the user scrolls.

## Phase 6: Annotation Extensions

- highlight
- underline
- strikeout
- area image
- sticky note
- post-creation color changes
- range-end adjustment
- undo / redo

Store annotation positions in PDF coordinates. Do not store CSS pixels or the
current zoom level.

Do not embed area-image data in Markdown as base64. Save it as an attachment in
the Rill library and use a relative link.

Completion gate: positions and images remain correct after zooming, rotation,
and restart.

## Phase 7: Markdown / Obsidian

Treat annotation JSON as canonical and the Highlights section in Markdown as a
projection.

- embed stable IDs in the Rill-managed section
- perform a three-way merge of the Rill base, current disk state, and Rill next
- preserve text written by the user outside the managed section
- show conflict UI only when the same annotation comment changed on both sides
- use atomic writes and backup generations

Completion gate: user-authored text is not lost when the same note is edited
alternately in Obsidian and Rill.

## Test Matrix

### Text and Column Layout

- single column
- two columns, bottom left -> top right
- two columns, top right -> bottom left
- three columns
- full-width heading + two-column body
- full-width figure or table inside body text
- footnotes
- header / footer / DOI / page number
- caption adjacent to body text

### Text Encoding

- `fi` / `fl` ligatures
- combining marks
- hyphenation
- OCR with one paragraph per line
- duplicated transparent text
- CJK
- RTL
- vertical writing
- text rotated 90 / 180 / 270 degrees
- Type 3 font

### Interaction

- forward / reverse drag
- double-click word selection
- triple-click line selection
- Shift + Click
- Shift + Arrow
- vertical scrolling while selecting
- cross-page selection
- selection while zoomed
- selection in spread mode
- color change immediately after selection
- restart after deleting an annotation

### Quality Criteria

Store the following for every fixture:

- expected text
- expected ordered line IDs
- expected page / rect count
- expected excluded regions
- agreement between forward / reverse selection

Require structural assertions for text and rectangles, not only image
snapshots.

## Known Limitations

- If a PDF lacks a correct character mapping, its text cannot be recovered
  without OCR.
- Complex tables do not have a single unambiguous reading order.
- Mathematical notation, footnotes, and sidebars require document-specific
  semantic inference.
- Rill must extend its format to represent one annotation across three or more
  pages.
- Updates to upstream require regression testing of the fork's `getPageData()`
  contract.

## Release Gate

The following conditions must be met before moving Reader Lab into main:

1. It operates entirely within the Rill UI.
2. All selection-order tests for representative fixtures pass.
3. Deletion and color changes do not produce state divergence.
4. JSON / Markdown restart round trips pass.
5. The AGPL / third-party notices and corresponding source URL are accessible
   from the DMG.
6. UI components do not call private upstream APIs directly.
