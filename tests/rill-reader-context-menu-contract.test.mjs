import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const bundle = await read("desktop/public/rill-pdf-engine/view.js");
const tree = ts.createSourceFile("view.js", bundle, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
let pdfClass;
function findPdfClass(node) {
  if (ts.isClassDeclaration(node) && node.name?.text === "PDFView") pdfClass = node;
  if (!pdfClass) ts.forEachChild(node, findPdfClass);
}
findPdfClass(tree);
function method(name, mac = true) {
  const member = pdfClass.members.find((node) => node.name?.getText(tree) === name);
  return new Function("isMac", `return ({${member.getText(tree)}}).${name};`)(() => mac);
}

function pdfHarness({ selected = true, editing = false, inPdf = true } = {}) {
  const requests = [];
  const annotation = { type: "highlight", text: "Selected English paragraph", position: { pageIndex: 0, rects: [[10, 20, 100, 40]] } };
  const view = {
    _options: { platform: "web", onContextMenu: (params) => requests.push(params) },
    _textAnnotationFocused: () => editing,
    _isSelectionCollapsed: () => !selected,
    _getAnnotationFromSelectionRanges: (ranges, kind) => {
      assert.equal(ranges, view._selectionRanges);
      assert.equal(kind, "highlight");
      return annotation;
    },
    _selectionRanges: [annotation],
    _iframe: { getBoundingClientRect: () => ({ x: 15, y: 25 }) },
    _pointerDownTriggered: true,
    _pointerDownTap: {},
  };
  view._handleContextMenu = method("_handleContextMenu");
  const event = {
    button: 2, clientX: 100, clientY: 150, ctrlKey: false,
    target: { closest: () => inPdf },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  return { view, event, requests, annotation };
}

test("PDF context menu replaces the iframe default and carries the unchanged selection", () => {
  const h = pdfHarness();
  h.view._handleContextMenu(h.event);
  assert.equal(h.event.defaultPrevented, true);
  assert.deepEqual(h.requests, [{ x: 115, y: 175, annotation: h.annotation }]);
  assert.equal(h.view._selectionRanges[0], h.annotation);
  assert.equal(h.view._pointerDownTriggered, false);
  assert.equal(h.view._pointerDownTap, null);
});

test("PDF context menu works with no selection without guessing a word or paragraph", () => {
  const h = pdfHarness({ selected: false });
  h.view._handleContextMenu(h.event);
  assert.equal(h.requests[0].annotation, null);
  assert.equal(h.event.defaultPrevented, true);
});

for (const scope of ["editing", "outside-PDF"]) {
  test(`native menus remain available while ${scope}`, () => {
    const h = pdfHarness({ editing: scope === "editing", inPdf: scope !== "outside-PDF" });
    h.view._handleContextMenu(h.event);
    assert.equal(h.requests.length, 0);
    assert.equal(h.event.defaultPrevented, false);
  });
}

for (const kind of ["right-click", "Control-click"]) {
  test(`${kind} does not enter the normal selection-start path`, () => {
    const h = pdfHarness();
    if (kind === "Control-click") { h.event.button = 0; h.event.ctrlKey = true; }
    // Deliberately omit normal selection methods: invoking one would fail.
    method("_handlePointerDown").call(h.view, h.event);
    assert.equal(h.event.defaultPrevented, true);
    assert.equal(h.view._selectionRanges[0], h.annotation);
    assert.equal(h.requests.length, kind === "Control-click" ? 1 : 0);
  });
}

const moduleUrls = new Map();
async function moduleUrl(name) {
  if (moduleUrls.has(name)) return moduleUrls.get(name);
  let javascript = ts.transpileModule(await read(`desktop/src/reader-engine/${name}.ts`), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  for (const match of [...javascript.matchAll(/from "\.\/([^"]+)"/g)]) {
    javascript = javascript.replace(match[0], `from "${await moduleUrl(match[1])}"`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  moduleUrls.set(name, url);
  return url;
}
const { IframeRillPdfEngine } = await import(await moduleUrl("IframeRillPdfEngine"));
const { PageGeometryCache } = await import(await moduleUrl("PageGeometryCache"));

function adapterHarness({ delayed = false } = {}) {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout, location: { href: "http://localhost/" } };
  const releases = [];
  const cache = new PageGeometryCache({ numPages: 10, getPage: async () => {
    if (delayed) await new Promise((resolve) => releases.push(resolve));
    return { view: [0, 0, 600, 800] };
  } });
  let listener;
  const frame = {
    getBoundingClientRect: () => ({ left: 200, top: 70 }),
    contentWindow: { Uint8Array, createRillPdfEngine: () => {
      queueMicrotask(() => listener({ type: "initialized" }));
      return { subscribe: (callback) => { listener = callback; return () => {}; }, clearSelection() {}, destroy() {} };
    } },
  };
  const engine = new IframeRillPdfEngine(frame, cache.boxes, (pages) => cache.ensure(pages));
  const events = [];
  engine.subscribe((event) => events.push(event));
  return { engine, events, emit: (event) => listener(event), release: () => releases.splice(0).forEach((resolve) => resolve()),
    restore: () => { engine.destroy(); globalThis.window = previousWindow; } };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("context menu adapter accounts for both iframe offsets and exact page geometry", async () => {
  const h = adapterHarness();
  try {
    await h.engine.open(new ArrayBuffer(1), []);
    h.emit({ type: "context-menu-requested", x: 115, y: 175, annotation: {
      type: "highlight", text: "Selected text", position: { pageIndex: 3, rects: [[60, 720, 180, 760]] },
    } });
    await nextTurn();
    const event = h.events.find((event) => event.type === "context-menu-requested");
    assert.deepEqual(event.anchor, { x: 315, y: 245 });
    assert.equal(event.annotation.text, "Selected text");
    assert.equal(event.annotation.page, 4);
    assert.equal(event.annotation.rects[0].x, 0.1);
    assert.equal(event.annotation.rects[0].height, 0.05);
    h.emit({ type: "context-menu-requested", x: 10, y: 20, annotation: null });
    assert.equal(h.events.at(-1).annotation, null);
    for (const x of [NaN, Infinity, "10", undefined]) h.emit({ type: "context-menu-requested", x, y: 20 });
    assert.deepEqual(h.events.at(-1).anchor, { x: 210, y: 90 });
  } finally { h.restore(); }
});

test("late page geometry cannot reopen a context menu after selection is cleared", async () => {
  const h = adapterHarness({ delayed: true });
  try {
    await h.engine.open(new ArrayBuffer(1), []);
    h.emit({ type: "context-menu-requested", x: 10, y: 20, annotation: {
      type: "highlight", text: "Old selection", position: { pageIndex: 3, rects: [[60, 720, 180, 760]] },
    } });
    h.engine.clearSelection();
    h.release();
    await nextTurn();
    assert.equal(h.events.filter((event) => event.type === "context-menu-requested").length, 0);
  } finally { h.restore(); }
});

test("Rill owns the menu UI and source patch keeps the context bridge reproducible", async () => {
  const reader = await read("desktop/src/RillPdfReader.tsx");
  const patch = await read("patches/zotero-reader/0001-rill-headless-selection-engine.patch");
  assert.match(reader, /role="menu" aria-label="PDFの操作"/);
  assert.match(reader, /disabled=\{!pending\?\.annotation\.text\}/);
  assert.match(reader, /pending && !contextMenuAnchor/);
  assert.match(reader, /if \(contextMenuAnchor \|\| pending\)/);
  assert.match(reader, /"ArrowDown", "ArrowUp", "Home", "End"/);
  assert.match(patch, /onContextMenu: this\._options\.onContextMenu/);
  assert.match(patch, /onContextMenu: params => emit\('context-menu-requested', params\)/);
  assert.match(bundle, /onContextMenu: params => emit\('context-menu-requested', params\)/);
});
