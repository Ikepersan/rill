import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("headless engine bundle does not ship the upstream Reader UI entry", async () => {
  const [html, css, bundle] = await Promise.all([
    read("desktop/public/rill-pdf-engine/view.html"),
    read("desktop/public/rill-pdf-engine/view.css"),
    read("desktop/public/rill-pdf-engine/view.js"),
  ]);
  assert.match(html, /Rill PDF selection engine/);
  assert.doesNotMatch(html, /Zotero|toolbar|selection-popup|annotation-popup/i);
  assert.doesNotMatch(css, /selection-popup|annotation-popup|context-menu|sidebar/i);
  assert.match(bundle, /createRillPdfEngine/);
  assert.doesNotMatch(bundle, /createReader\s*=/);
});

test("React reader uses only the public Rill engine boundary and five Rill colors", async () => {
  const [reader, app] = await Promise.all([
    read("desktop/src/RillPdfReader.tsx"),
    read("desktop/src/App.tsx"),
  ]);
  assert.match(app, /lazy\(\(\) => import\("\.\/RillPdfReader"\)/);
  assert.doesNotMatch(app, /ZoteroPdfReader/);
  assert.doesNotMatch(reader, /_primaryView|\._render\(|createReader|zotero-reader/i);
  for (const color of ["yellow", "red", "green", "blue", "purple"]) {
    assert.match(reader, new RegExp(`color: "${color}"`));
  }
  for (const kind of ["highlight", "underline", "strikeout"]) {
    assert.match(reader, new RegExp(`"${kind}"`));
  }
});

test("PDF work is bounded and avoids byte-array memory amplification", async () => {
  const [reader, adapter, bundle] = await Promise.all([
    read("desktop/src/RillPdfReader.tsx"),
    read("desktop/src/reader-engine/IframeRillPdfEngine.ts"),
    read("desktop/public/rill-pdf-engine/view.js"),
  ]);
  assert.match(reader, /MAX_READER_PAGES/);
  assert.match(reader, /MAX_CAPTURE_PIXELS/);
  assert.match(reader, /IntersectionObserver/);
  assert.match(adapter, /new frameWindow\.Uint8Array\(pdf\)/);
  assert.doesNotMatch(adapter, /Array\.from\(new Uint8Array\(pdf\)\)/);
  assert.match(reader, /enableScripting:\s*false/);
  assert.match(reader, /isEvalSupported:\s*false/);
  assert.match(reader, /\["http:", "https:", "mailto:"\]\.includes\(target\.protocol\)/);
  assert.match(reader, /noopener,noreferrer/);
  assert.match(bundle, /PDFViewerApplicationOptions\.set\('enableScripting', false\)/);
  assert.match(bundle, /PDFViewerApplicationOptions\.set\('isEvalSupported', false\)/);
});

test("persisted PDF annotation geometry is rejected before engine conversion", async () => {
  const [source, adapter] = await Promise.all([
    read("desktop/src/reader-engine/sanitizeAnnotationGeometry.ts"),
    read("desktop/src/reader-engine/IframeRillPdfEngine.ts"),
  ]);
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  const sanitize = loadedModule.sanitizePersistedAnnotationGeometry;

  const firstPageRect = { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.04 };
  const nextPageRect = { page: 2, x: 0.2, y: 0.1, width: 0.4, height: 0.05 };
  assert.deepEqual(sanitize({ page: 1, rects: [nextPageRect, firstPageRect] }, 2), {
    page: 1,
    rects: [firstPageRect],
    nextPageRects: [nextPageRect],
  });
  assert.deepEqual(sanitize({ page: 2, rects: [{ ...firstPageRect, page: null }] }, 2), {
    page: 2,
    rects: [{ ...firstPageRect, page: 2 }],
  });
  const clamped = sanitize({
    page: 1,
    rects: [{ page: 1, x: -5e-7, y: 0.9, width: 0.2, height: 0.1000005 }],
  }, 1);
  assert.equal(clamped.page, 1);
  assert.equal(clamped.rects[0].x, 0);
  assert.equal(clamped.rects[0].y, 0.9);
  assert.ok(Math.abs(clamped.rects[0].width - 0.1999995) < 1e-12);
  assert.ok(Math.abs(clamped.rects[0].height - 0.1) < 1e-12);
  const exactBoundary = sanitize({
    page: 1,
    rects: [
      { page: 1, x: 0.8, y: 0.1, width: 0.200001, height: 0.1 },
      { page: 1, x: 0.1, y: 0.9, width: 0.1, height: 0.100001 },
    ],
  }, 1);
  assert.equal(exactBoundary.rects.length, 2);
  assert.ok(exactBoundary.rects.every((rect) => rect.x >= 0 && rect.y >= 0));
  assert.ok(exactBoundary.rects.every((rect) => rect.x + rect.width <= 1 && rect.y + rect.height <= 1));
  assert.equal(loadedModule.sanitizePersistedAnnotationColor("orange"), "yellow");
  assert.equal(loadedModule.sanitizePersistedAnnotationKind("note"), "highlight");

  const malformed = [
    { page: 0, rects: [firstPageRect] },
    { page: 1, rects: [] },
    { page: 1, rects: [{ ...firstPageRect, page: 1.5 }] },
    { page: 1, rects: [{ ...firstPageRect, x: Number.NaN }] },
    { page: 1, rects: [{ ...firstPageRect, y: Number.POSITIVE_INFINITY }] },
    { page: 1, rects: [{ ...firstPageRect, x: -0.01 }] },
    { page: 1, rects: [{ ...firstPageRect, width: 0 }] },
    { page: 1, rects: [{ ...firstPageRect, height: -0.01 }] },
    { page: 1, rects: [{ ...firstPageRect, x: 0.8, width: 0.3 }] },
    { page: 1, rects: [{ ...firstPageRect, y: 0.98, height: 0.04 }] },
    { page: 1, rects: [{ ...firstPageRect, x: -2e-6 }] },
    { page: 1, rects: [{ ...firstPageRect, y: 0.9, height: 0.100002 }] },
    { page: 1, rects: [firstPageRect, { ...nextPageRect, page: 3 }] },
    { page: 1, rects: [firstPageRect, nextPageRect, { ...firstPageRect, page: 3 }] },
    { page: 1, rects: [firstPageRect, { ...nextPageRect, width: 0 }] },
  ];
  for (const annotation of malformed) {
    assert.equal(sanitize(annotation, 3), null);
  }
  assert.equal(sanitize({ page: 3, rects: [firstPageRect] }, 2), null);
  assert.equal(sanitize({ page: 2, rects: [{ ...nextPageRect, page: 3 }] }, 2), null);
  assert.equal(sanitize({ page: 1, rects: [firstPageRect] }, 0), null);

  assert.match(adapter, /sanitizePersistedAnnotationGeometry\(annotation, this\.boxes\.length\)/);
  assert.match(adapter, /sanitizePersistedAnnotationGeometry\(converted, this\.boxes\.length\)/);
  assert.match(adapter, /filter\(isEngineAnnotation\)/);
  assert.match(adapter, /position\.rects\.every\(isEngineRect\)/);
  assert.match(adapter, /isUsablePageBox\(nextPageBox\)/);
});

test("selected PDF text can be copied without creating an annotation", async () => {
  const [readerSource, copySource, adapterSource, typeSource, bundle] = await Promise.all([
    read("desktop/src/RillPdfReader.tsx"),
    read("desktop/src/reader-engine/copyText.ts"),
    read("desktop/src/reader-engine/IframeRillPdfEngine.ts"),
    read("desktop/src/reader-engine/types.ts"),
    read("desktop/public/rill-pdf-engine/view.js"),
  ]);
  assert.match(readerSource, /copyPlainText\(selection\.annotation\.text\)/);
  assert.match(readerSource, /copy-selection[\s\S]*コピー<\/button>/);
  assert.match(readerSource, /選択した文章をコピーしました/);
  assert.doesNotMatch(
    readerSource.match(/async function copyPendingSelection\(\)[\s\S]*?\n  \}/)?.[0] ?? "",
    /repositoryRef\.current\?\.update/,
  );
  assert.match(copySource, /writer\.writeText\(text\)/);
  assert.match(copySource, /document\.execCommand\("copy"\)/);
  assert.match(typeSource, /type: "shortcut"; command: "copy-selection" \| "focus-search"/);
  assert.match(adapterSource, /event\.type === "shortcut"/);
  assert.match(bundle, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(bundle, /command: 'copy-selection'/);
  assert.match(bundle, /command: 'focus-search'/);
  assert.match(bundle, /removeEventListener\('keydown', onKeyDown, true\)/);
  assert.match(readerSource, /addEventListener\("rill:\/\/copy-request", handleCopyRequest\)/);
  assert.match(readerSource, /handleCopyRequest[\s\S]*event\.preventDefault\(\)[\s\S]*copyPendingSelection\(\)/);
});

test("Library exposes every tag in an independently scrollable list", async () => {
  const [app, css] = await Promise.all([
    read("desktop/src/App.tsx"),
    read("desktop/src/styles.css"),
  ]);
  const tagList = app.match(/<div className="sidebar-tag-list"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(tagList, /papers\.flatMap\(\(paper\) => paper\.tags\)/);
  assert.doesNotMatch(tagList, /\.slice\(/);
  assert.match(css, /\.sidebar-tag-list\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
});

test("PDF text copying handles clipboard and fallback failures without leaking DOM elements", async () => {
  const source = await read("desktop/src/reader-engine/copyText.ts");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const copyModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

  const writes = [];
  assert.equal(await copyModule.copyPlainText("selected", {
    writeText: async (text) => { writes.push(text); },
  }), true);
  assert.deepEqual(writes, ["selected"]);

  let removed = 0;
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    select() {},
    remove() { removed += 1; },
  };
  const fallbackDocument = {
    createElement: () => textarea,
    body: { appendChild() {} },
    execCommand: () => true,
  };
  assert.equal(await copyModule.copyPlainText(
    "fallback",
    { writeText: async () => { throw new Error("denied"); } },
    fallbackDocument,
  ), true);
  assert.equal(textarea.value, "fallback");
  assert.equal(removed, 1);

  const throwingDocument = {
    ...fallbackDocument,
    execCommand: () => { throw new Error("blocked"); },
  };
  assert.equal(await copyModule.copyPlainText(
    "blocked",
    { writeText: async () => { throw new Error("denied"); } },
    throwingDocument,
  ), false);
  assert.equal(removed, 2);

  assert.equal(await copyModule.copyPlainText("", {
    writeText: async () => { throw new Error("should not write"); },
  }), false);
});

test("AnnotationRepository retains unsaved edits after a failed save", async () => {
  const source = await read("desktop/src/reader-engine/AnnotationRepository.ts");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const repositoryModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  let rejectSave;
  const messages = [];
  const repository = new repositoryModule.AnnotationRepository(
    () => new Promise((_, reject) => { rejectSave = reject; }),
    (message) => messages.push(message),
  );
  const states = [];
  repository.subscribe((state) => states.push(state));
  repository.initialize([]);
  const annotation = {
    id: "a1", page: 1, text: "selected text", color: "yellow", kind: "highlight",
    comment: "", rects: [{ page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.03 }], createdAt: "2026-07-19T00:00:00Z",
  };
  repository.update((current) => [...current, annotation]);
  assert.equal(states.at(-1).annotations.length, 1);
  const revisionBeforeFailure = states.at(-1).revision;
  await new Promise((resolve) => setTimeout(resolve, 0));
  rejectSave(new Error("disk full"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).annotations.length, 1);
  assert.equal(states.at(-1).status, "error");
  assert.equal(states.at(-1).revision, revisionBeforeFailure);
  assert.match(messages.at(-1), /編集内容は画面に残しています/);
});

test("annotation flush rejects persistent failures, retains the latest edits, and can recover", async () => {
  const source = await read("desktop/src/reader-engine/AnnotationRepository.ts");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { AnnotationRepository } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  let failing = true;
  const writes = [];
  const repository = new AnnotationRepository(async (snapshot) => {
    if (failing) throw new Error("disk full");
    writes.push(snapshot);
  }, () => {});
  const states = [];
  repository.subscribe((state) => states.push(state));
  repository.initialize([]);
  const annotation = {
    id: "retry", page: 1, text: "selected text", color: "yellow", kind: "highlight",
    comment: "", rects: [{ page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.03 }], createdAt: "2026-10-06T00:00:00Z",
  };
  repository.update(() => [annotation]);
  repository.update((current) => current.map((item) => ({ ...item, comment: "newer unsaved comment" })));
  await assert.rejects(repository.flush(), /disk full/);
  assert.equal(repository.snapshot[0].comment, "newer unsaved comment");
  assert.equal(states.at(-1).status, "error");
  failing = false;
  await repository.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].comment, "newer unsaved comment");
  assert.equal(states.at(-1).status, "saved");
});

test("an older queued annotation save never marks a newer draft as saved", async () => {
  const source = await read("desktop/src/reader-engine/AnnotationRepository.ts");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { AnnotationRepository } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  let release;
  const writes = [];
  const repository = new AnnotationRepository(async (snapshot) => {
    writes.push(snapshot);
    if (writes.length === 1) await new Promise((resolve) => { release = resolve; });
  }, () => {});
  const states = [];
  repository.subscribe((state) => states.push(state));
  repository.initialize([]);
  const annotation = { id: "draft", page: 1, text: "text", color: "yellow", kind: "highlight", comment: "", rects: [], createdAt: "2026-10-06T00:00:00Z" };
  repository.update(() => [annotation]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  repository.update((current) => current.map((item) => ({ ...item, comment: "still editing" })), { persist: false });
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).status, "dirty");
  await repository.flush();
  assert.equal(writes.at(-1)[0].comment, "still editing");
  assert.equal(states.at(-1).status, "saved");
});

test("annotation flush also persists comment edits made while it is saving", async () => {
  const source = await read("desktop/src/reader-engine/AnnotationRepository.ts");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { AnnotationRepository } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  const releases = [];
  const writes = [];
  const repository = new AnnotationRepository(async (snapshot) => {
    writes.push(snapshot);
    if (writes.length <= 2) await new Promise((resolve) => { releases.push(resolve); });
  }, () => {});
  repository.initialize([]);
  repository.update(() => [{ id: "flush-race", page: 1, text: "text", color: "yellow", kind: "highlight", comment: "", rects: [], createdAt: "2026-10-06T00:00:00Z" }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  repository.update((current) => current.map((item) => ({ ...item, comment: "first edit" })), { persist: false });
  const flushing = repository.flush();
  releases[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  repository.update((current) => current.map((item) => ({ ...item, comment: "new edit during flush" })), { persist: false });
  releases[1]();
  await flushing;
  assert.equal(writes.length, 3);
  assert.equal(writes.at(-1)[0].comment, "new edit during flush");
});

test("rillReadingOrderV2 reorders only high-confidence two-column geometry", async () => {
  const source = await read("desktop/src/reader-engine/rillReadingOrderV2.ts");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  const annotation = {
    id: "two-columns", page: 1, text: "right top\nright bottom\nleft top\nleft bottom", color: "yellow", kind: "highlight",
    comment: "", createdAt: "2026-07-19T00:00:00Z",
    rects: [
      { page: 1, x: 0.58, y: 0.1, width: 0.32, height: 0.03 },
      { page: 1, x: 0.58, y: 0.2, width: 0.32, height: 0.03 },
      { page: 1, x: 0.08, y: 0.1, width: 0.32, height: 0.03 },
      { page: 1, x: 0.08, y: 0.2, width: 0.32, height: 0.03 },
    ],
  };
  const reordered = loadedModule.rillReadingOrderV2(annotation);
  assert.equal(reordered.strategy, "rillReadingOrderV2");
  assert.equal(reordered.annotation.text, "left top\nleft bottom\nright top\nright bottom");
  assert.ok(reordered.confidence >= 0.82);

  const ambiguous = loadedModule.rillReadingOrderV2({ ...annotation, text: "no line mapping" });
  assert.equal(ambiguous.strategy, "upstream");
  assert.equal(ambiguous.annotation.text, "no line mapping");
});

test("native iframe selection clearing does not dismiss Rill's annotation menu", async () => {
  const source = await read("desktop/src/reader-engine/selectionLifecycle.ts");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  const pending = { text: "selected text" };
  assert.equal(loadedModule.nextPendingSelection(pending, { type: "native-cleared" }), pending);
  assert.equal(loadedModule.nextPendingSelection(pending, { type: "cancel" }), null);
  assert.deepEqual(loadedModule.nextPendingSelection(pending, { type: "finalized", value: { text: "new" } }), { text: "new" });
});

test("reader lifecycle stays mounted and dismisses the Rill popup explicitly", async () => {
  const [reader, adapter, types, app, bundle] = await Promise.all([
    read("desktop/src/RillPdfReader.tsx"),
    read("desktop/src/reader-engine/IframeRillPdfEngine.ts"),
    read("desktop/src/reader-engine/types.ts"),
    read("desktop/src/App.tsx"),
    read("desktop/public/rill-pdf-engine/view.js"),
  ]);
  assert.match(reader, /\[iframeReady, paperId, paperPath, root\]/);
  assert.doesNotMatch(reader, /\[iframeReady, onToast, paper, root\]/);
  assert.match(app, /!root \|\| view === "reader"/);
  assert.match(types, /type: "backdrop-tapped"/);
  assert.match(reader, /event\.type === "backdrop-tapped"/);
  assert.match(reader, /closest\("\.selection-menu"\)/);
  assert.match(reader, /performance\.now\(\) - menuPointerDownAtRef\.current < 500/);
  assert.match(reader, /setTimeout\(\(\) => \{[\s\S]*updatePendingSelection\(null\)[\s\S]*\}, 350\)/);
  assert.doesNotMatch(adapter, /finalizeSelection|selectionchange/);
  assert.doesNotMatch(bundle, /finalizeSelection: \(\) => view\.finalizeSelection\(\)/);
});

test("Back and Escape wait for annotation persistence before leaving the reader", async () => {
  const reader = await read("desktop/src/RillPdfReader.tsx");

  assert.match(
    reader,
    /const closeReader = useCallback\(async \(\) => \{[\s\S]*?await repositoryRef\.current\?\.flush\(\)[\s\S]*?onCloseRef\.current\(\)/,
  );
  assert.match(reader, /event\.key !== "Escape"[\s\S]*?void closeReader\(\)/);
  assert.match(reader, /className="reader-back" onClick=\{\(\) => \{ void closeReader\(\); \}\}/);
  assert.match(
    reader,
    /const finalFlush = repository\?\.flush\(\) \?\? Promise\.resolve\(\);[\s\S]*?onRegisterFlushRef\.current\?\.\(\(\) => finalFlush\)/,
  );
  assert.match(reader, /void finalFlush\.catch\(\(\) => undefined\)/);
  assert.match(reader, /保存エラー・未保存/);
  assert.match(reader, /保存を再試行/);
  assert.doesNotMatch(reader, /if \(repository\) void repository\.flush\(\);\s+onRegisterFlush\?\.\(null\)/);
});

test("the macOS source targets Rill 1.0.4", async () => {
  const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
  assert.equal(config.productName, "Rill");
  assert.equal(config.version, "1.0.4");
  assert.equal(config.identifier, "app.rill.library");
});

test("bundled engine records source, patch, licenses and fixed commits", async () => {
  const [license, releaseNotice, notice, provenance, patch, pdfLicense, buildScript, configSource] = await Promise.all([
    read("LICENSE"),
    read("AGPL_NOTICE.md"),
    read("THIRD_PARTY_NOTICES.md"),
    read("desktop/public/rill-pdf-engine/PROVENANCE.md"),
    read("patches/zotero-reader/0001-rill-headless-selection-engine.patch"),
    read("desktop/public/rill-pdf-engine/pdf/LICENSE"),
    read("scripts/build_rill_pdf_engine.sh"),
    read("src-tauri/tauri.conf.json"),
  ]);
  const commit = "c12c65e3f01414ae244f6102da4028c700cf6584";
  const pdfjsCommit = "f57fc80d1c07e4cdc50a767ae0b500b5272123b4";
  assert.match(license, /^\s*GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);
  assert.doesNotMatch(license, /pdf-reader is copyright|Zotero name is a registered trademark/);
  assert.match(releaseNotice, /Rill 1\.0\.4/);
  assert.match(releaseNotice, /github\.com\/Ikepersan\/rill\/tree\/v1\.0\.4/);
  assert.match(notice, /Rill 1\.0\.4/);
  assert.doesNotMatch(notice, /Rill 0\.7\.11/);
  assert.match(notice, /modified for Rill on 2026-07-19/);
  assert.match(notice, new RegExp(commit));
  assert.match(notice, new RegExp(pdfjsCommit));
  assert.match(provenance, new RegExp(commit));
  assert.match(provenance, new RegExp(pdfjsCommit));
  assert.match(notice, /AGPL/i);
  assert.match(pdfLicense, /Apache License\s+Version 2\.0/);
  assert.match(buildScript, new RegExp(commit));
  assert.match(buildScript, new RegExp(pdfjsCommit));
  assert.match(configSource, /PDFJS-APACHE-2\.0\.txt/);
  assert.match(patch, /createRillPdfEngine/);
  assert.match(patch, /selection-finalized/);
});
