import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Overview and Library expose visible PDF drop affordances", async () => {
  const [app, styles] = await Promise.all([
    read("desktop/src/App.tsx"),
    read("desktop/src/styles.css"),
  ]);

  assert.match(app, /ドロップして未整理に追加/);
  assert.match(app, /pdfDropTarget === "header"/);
  assert.match(app, /pdfDropTarget === "overview"/);
  assert.match(app, /pdfDropTarget === "library"/);
  assert.match(app, /targetAtPosition/);
  assert.match(app, /const acceptsPdfDrop = showAddDropZone \|\| view === "overview"/);
  assert.match(app, /const x = event\.position\.x;/);
  assert.match(app, /const y = event\.position\.y;/);
  assert.doesNotMatch(app, /event\.position\.[xy] \/ scale/);
  assert.match(app, /aria-expanded=\{showAddDropZone\}/);
  assert.match(styles, /\.overview-pdf-drop\.drop-active/);
  assert.match(styles, /\.header-pdf-drop-panel\.drop-active/);
  assert.match(styles, /\.paper-list-panel\.drop-active/);
  assert.match(styles, /\.drop-confirm-overlay/);
  assert.match(app, /このPDFはすでにライブラリにあります/);
});

test("Selecting the active paper again or clicking list whitespace closes Paper details", async () => {
  const app = await read("desktop/src/App.tsx");

  assert.match(app, /selectedId === paper\.id/);
  assert.match(app, /if \(event\.target === event\.currentTarget\) setSelectedId\(null\)/);
});

test("Paper details overlays the library and remembers a user-selected width", async () => {
  const [app, styles] = await Promise.all([
    read("desktop/src/App.tsx"),
    read("desktop/src/styles.css"),
  ]);

  assert.match(app, /rill-paper-details-width/);
  assert.match(app, /className="inspector-resize-handle"/);
  assert.match(app, /startInspectorResize/);
  assert.match(styles, /\.inspector \{ position: absolute;/);
  assert.match(styles, /\.inspector-resize-handle/);
  assert.doesNotMatch(styles, /\.library-view:has\(\.inspector\)/);
});
