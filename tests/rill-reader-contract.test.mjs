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
  assert.match(app, /import \{ RillPdfReader \}/);
  assert.doesNotMatch(app, /ZoteroPdfReader/);
  assert.doesNotMatch(reader, /_primaryView|\._render\(|createReader|zotero-reader/i);
  for (const color of ["yellow", "red", "green", "blue", "purple"]) {
    assert.match(reader, new RegExp(`color: "${color}"`));
  }
  for (const kind of ["highlight", "underline", "strikeout"]) {
    assert.match(reader, new RegExp(`"${kind}"`));
  }
});

test("AnnotationRepository updates optimistically and rolls back a failed save", async () => {
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
  assert.equal(states.at(-1).annotations.length, 0);
  assert.equal(states.at(-1).status, "error");
  assert.ok(states.at(-1).revision > revisionBeforeFailure);
  assert.match(messages.at(-1), /直前の状態へ戻しました/);
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
  assert.match(reader, /nextPendingSelection\(current, \{ type: "cancel" \}\)[\s\S]*350/);
  assert.doesNotMatch(adapter, /finalizeSelection|selectionchange/);
  assert.doesNotMatch(bundle, /finalizeSelection: \(\) => view\.finalizeSelection\(\)/);
});

test("the current macOS release is Rill 1.0.0", async () => {
  const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
  assert.equal(config.productName, "Rill");
  assert.equal(config.version, "1.0.0");
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
  assert.match(license, /AGPL-3\.0-only/);
  assert.match(releaseNotice, /Rill 1\.0\.0/);
  assert.match(releaseNotice, /github\.com\/Ikepersan\/rill\/tree\/v1\.0\.0/);
  assert.match(notice, /Rill 1\.0\.0/);
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
