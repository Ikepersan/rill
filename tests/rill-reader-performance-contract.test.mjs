import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sourceRoot = new URL("../desktop/src/reader-engine/", import.meta.url);
const urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let javascript = ts.transpileModule(await readFile(new URL(`${name}.ts`, sourceRoot), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  for (const match of [...javascript.matchAll(/from "\.\/([^"]+)"/g)]) {
    javascript = javascript.replace(match[0], `from "${await moduleUrl(match[1])}"`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  urls.set(name, url);
  return url;
}
const { PageGeometryCache, annotationPages } = await import(await moduleUrl("PageGeometryCache"));
const { IframeRillPdfEngine } = await import(await moduleUrl("IframeRillPdfEngine"));

function geometryHarness({ delayed = false } = {}) {
  const requests = [];
  const releases = [];
  let fail = false;
  const cache = new PageGeometryCache({
    numPages: 100,
    getPage: async (number) => {
      requests.push(number);
      if (delayed) await new Promise((resolve) => releases.push(resolve));
      if (fail) throw new Error("Page unavailable");
      return { view: number === 1 ? [0, 0, 600, 800] : [10, 20, 410, 620] };
    },
  });
  return { cache, requests, release: () => releases.splice(0).forEach((resolve) => resolve()), fail: (value) => { fail = value; } };
}

function engineHarness(cache) {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout, location: { href: "http://localhost/" } };
  let listener;
  let options;
  const snapshots = [];
  const frame = {
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    contentWindow: {
      Uint8Array,
      createRillPdfEngine: (value) => {
        options = value;
        queueMicrotask(() => listener({ type: "initialized" }));
        return {
          subscribe: (callback) => { listener = callback; return () => {}; },
          setAnnotations: (annotations, revision) => { snapshots.push({ annotations, revision }); return true; },
          clearSelection: () => {}, destroy: () => {},
        };
      },
    },
  };
  const engine = new IframeRillPdfEngine(frame, cache.boxes, (pages) => cache.ensure(pages));
  const events = [];
  engine.subscribe((event) => events.push(event));
  return {
    engine, events, snapshots, options: () => options, emit: (event) => listener(event),
    restore: () => { engine.destroy(); globalThis.window = previousWindow; },
  };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const savedAnnotation = {
  id: "saved", page: 18, kind: "highlight", color: "yellow", text: "Saved text", comment: "",
  createdAt: "2026-10-01T00:00:00Z",
  rects: [{ page: 18, x: 0.1, y: 0.1, width: 0.2, height: 0.04 }],
};
const selection = (pageIndex) => ({
  type: "selection-finalized", rect: [10, 20, 100, 80],
  annotation: { type: "highlight", text: "English paragraph", position: { pageIndex, rects: [[50, 500, 130, 560]] } },
});

test("geometry loads only requested pages and preserves exact mixed CropBoxes", async () => {
  const h = geometryHarness();
  await h.cache.ensure([1]);
  assert.deepEqual(h.requests, [1]);
  assert.equal(h.cache.boxes.length, 100);
  assert.equal(h.cache.boxes[99], undefined);
  await h.cache.ensure([40]);
  assert.deepEqual(h.cache.boxes[39], { x0: 10, y0: 20, x1: 410, y1: 620 });
  await h.cache.ensure([40, 0, -1, 101, 1.5, NaN]);
  assert.deepEqual(h.requests, [1, 40]);
});

test("geometry shares in-flight requests and retries after failure", async () => {
  const h = geometryHarness({ delayed: true });
  const first = h.cache.ensure([2, 2]);
  const second = h.cache.ensure([2]);
  assert.deepEqual(h.requests, [2]);
  h.release();
  await Promise.all([first, second]);
  h.fail(true);
  const rejected = h.cache.ensure([3]);
  h.release();
  await assert.rejects(rejected, /Page unavailable/);
  h.fail(false);
  const retry = h.cache.ensure([3]);
  h.release();
  await retry;
  assert.deepEqual(h.requests, [2, 3, 3]);
});

test("opening restores saved annotations without scanning unannotated pages", async () => {
  const h = geometryHarness();
  const e = engineHarness(h.cache);
  try {
    await e.engine.open(new ArrayBuffer(1), [savedAnnotation]);
    assert.deepEqual(h.requests, [18]);
    assert.deepEqual(e.options().annotations[0].position.rects, [[50, 536, 130, 560]]);
    assert.equal(e.options().annotations[0].text, "Saved text");
    e.emit({ type: "view-stats-changed", stats: { pagesCount: 100, pageIndex: 20 } });
    await nextTurn();
    assert.deepEqual(h.requests, [18, 21, 22]);
  } finally { e.restore(); }
});

test("lazy cross-page selection uses both page geometries before emitting", async () => {
  const h = geometryHarness();
  const e = engineHarness(h.cache);
  try {
    await e.engine.open(new ArrayBuffer(1), []);
    const event = selection(39);
    event.annotation.position.nextPageRects = [[50, 500, 130, 560]];
    e.emit(event);
    await nextTurn();
    const selected = e.events.find((value) => value.type === "selection-finalized");
    assert.equal(selected.annotation.text, "English paragraph");
    assert.deepEqual(selected.annotation.rects.map((rect) => rect.page), [40, 41]);
    assert.equal(selected.annotation.rects[0].x, 0.1);
    assert.equal(selected.annotation.rects[0].height, 0.1);
    assert.deepEqual(h.requests, [40, 41]);
  } finally { e.restore(); }
});

for (const cancel of ["clear", "new-selection", "destroy"]) {
  test(`pending geometry cannot revive an obsolete selection after ${cancel}`, async () => {
    const h = geometryHarness({ delayed: true });
    const e = engineHarness(h.cache);
    try {
      await e.engine.open(new ArrayBuffer(1), []);
      e.emit(selection(39));
      if (cancel === "clear") e.engine.clearSelection();
      if (cancel === "new-selection") e.emit(selection(49));
      if (cancel === "destroy") e.engine.destroy();
      h.release();
      await nextTurn();
      const selected = e.events.filter((value) => value.type === "selection-finalized");
      assert.equal(selected.length, cancel === "new-selection" ? 1 : 0);
      if (selected.length) assert.equal(selected[0].annotation.page, 50);
    } finally { e.restore(); }
  });
}

test("save-status-only notifications do not resend annotation snapshots", async () => {
  const h = geometryHarness();
  const e = engineHarness(h.cache);
  try {
    await e.engine.open(new ArrayBuffer(1), [savedAnnotation]);
    e.engine.setAnnotations([savedAnnotation], 1);
    e.engine.setAnnotations([savedAnnotation], 1);
    e.engine.setAnnotations([savedAnnotation], 1);
    e.engine.setAnnotations([], 2); // The save-failure rollback must still reach the engine.
    assert.deepEqual(e.snapshots.map((value) => value.revision), [1, 2]);
    assert.deepEqual(e.snapshots[1].annotations, []);
  } finally { e.restore(); }
});

test("initial geometry includes next-page annotation rectangles", () => {
  assert.deepEqual(annotationPages([{ ...savedAnnotation, rects: [{ page: 19 }, {}] }]), [18, 19, 18]);
});

test("thumbnail callbacks remain stable and outline work follows engine opening", async () => {
  const reader = await readFile(new URL("../desktop/src/RillPdfReader.tsx", import.meta.url), "utf8");
  assert.match(reader, /const PdfThumbnail = memo\(function/);
  assert.match(reader, /const goToPage = useCallback/);
  assert.match(reader, /onSelect=\{goToPage\}/);
  assert.ok(reader.indexOf("await engine.open") < reader.indexOf("void document.getOutline()"));
  assert.doesNotMatch(reader, /for \(let number = 1; number <= document.numPages/);
});
