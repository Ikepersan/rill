import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../desktop/src/App.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "App");
const functionNames = new Set([
  "reservePaperRevision", "updateDraft", "applyTranslationIfCurrent", "translateDraftSummary",
]);
// Execute the actual handlers without mounting the unrelated library/reader UI.
const handlers = app.body.statements
  .filter((node) => ts.isFunctionDeclaration(node) && functionNames.has(node.name?.text))
  .map((node) => node.getText(parsed)).join("\n");
const javascript = ts.transpileModule(handlers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const bindHandlers = new Function("context", `
  const { draft, draftRef, draftRevision, latestRevisionByPaper, draftDirty,
    setDraft, setToast, setBusy, invoke, isTauri } = context;
  ${javascript}
  return { translateDraftSummary, updateDraft };
`);

function createHarness({ trackedRevision = true } = {}) {
  const draft = {
    id: "paper-a", title: "Original title", summary: "English abstract",
    clinicalNote: "Original note", translatedSummary: "", noteRevision: "disk-before-save",
  };
  const draftRef = { current: draft };
  const draftRevision = { current: 7 };
  const latestRevisionByPaper = { current: new Map(trackedRevision ? [[draft.id, 7]] : []) };
  const draftDirty = { current: false };
  const updates = [];
  const messages = [];
  const busy = [];
  const requests = [];
  let resolveTranslation;
  let rejectTranslation;
  const translation = new Promise((resolve, reject) => {
    resolveTranslation = resolve;
    rejectTranslation = reject;
  });
  const { translateDraftSummary, updateDraft } = bindHandlers({
    draft, draftRef, draftRevision, latestRevisionByPaper, draftDirty, isTauri: true,
    setDraft: (paper) => updates.push(paper),
    setToast: (message) => messages.push(message),
    setBusy: (value) => busy.push(value),
    invoke: (command, args) => { requests.push({ command, args }); return translation; },
  });
  return {
    draft, draftRef, draftRevision, latestRevisionByPaper, draftDirty,
    updates, messages, busy, requests, resolveTranslation, rejectTranslation,
    translate: translateDraftSummary, edit: updateDraft,
  };
}

for (const trackedRevision of [true, false]) {
  test(`translation updates an unchanged draft through the normal edit path (tracked revision: ${trackedRevision})`, async () => {
    const h = createHarness({ trackedRevision });
    const pending = h.translate();
    assert.deepEqual(h.requests, [{ command: "translate_summary", args: { text: "English abstract" } }]);
    assert.deepEqual(h.busy, [true]);
    assert.equal(h.updates.length, 0);

    h.resolveTranslation("日本語の要約");
    await pending;

    assert.deepEqual(h.draftRef.current, { ...h.draft, translatedSummary: "日本語の要約" });
    assert.equal(h.updates.length, 1);
    assert.equal(h.draftDirty.current, true);
    assert.equal(h.latestRevisionByPaper.current.get("paper-a"), 8);
    assert.equal(h.draft.translatedSummary, "");
    assert.deepEqual(h.busy, [true, false]);
    assert.match(h.messages.at(-1), /翻訳しました/);
  });
}

for (const field of ["summary", "clinicalNote", "translatedSummary", "title"]) {
  test(`translation preserves a newer ${field} edit even after its autosave completes`, async () => {
    const h = createHarness();
    const pending = h.translate();
    h.edit({ ...h.draftRef.current, [field]: "New user edit" });
    const edited = { ...h.draftRef.current, noteRevision: "disk-after-edit" };
    h.draftRef.current = edited;
    h.draftDirty.current = false;

    h.resolveTranslation("古い要約に対する和訳");
    await pending;

    assert.equal(h.draftRef.current, edited);
    assert.equal(h.updates.length, 1);
    assert.equal(h.draftDirty.current, false);
    assert.equal(h.latestRevisionByPaper.current.get("paper-a"), 8);
    assert.deepEqual(h.busy, [true, false]);
    assert.match(h.messages.at(-1), /反映しませんでした/);
  });
}

test("translation does not replace another selected paper with the same revision", async () => {
  const h = createHarness();
  const pending = h.translate();
  const selected = { ...h.draft, id: "paper-b", title: "Another paper" };
  h.draftRef.current = selected;
  h.latestRevisionByPaper.current.set(selected.id, 7);

  h.resolveTranslation("文献Aの和訳");
  await pending;

  assert.equal(h.draftRef.current, selected);
  assert.equal(h.updates.length, 0);
  assert.deepEqual(h.busy, [true, false]);
  assert.match(h.messages.at(-1), /反映しませんでした/);
});

test("translation does not reopen a closed draft", async () => {
  const h = createHarness();
  const pending = h.translate();
  h.draftRef.current = null;

  h.resolveTranslation("和訳");
  await pending;

  assert.equal(h.draftRef.current, null);
  assert.equal(h.updates.length, 0);
  assert.deepEqual(h.busy, [true, false]);
  assert.match(h.messages.at(-1), /反映しませんでした/);
});

test("translation keeps the current save acknowledgement instead of the request snapshot", async () => {
  const h = createHarness();
  const pending = h.translate();
  h.draftRef.current = { ...h.draft, noteRevision: "disk-after-save" };

  h.resolveTranslation("和訳");
  await pending;

  assert.equal(h.draftRef.current.noteRevision, "disk-after-save");
  assert.equal(h.draftRef.current.translatedSummary, "和訳");
  assert.equal(h.updates.length, 1);
});

test("translation errors leave the draft untouched and release busy state", async () => {
  const h = createHarness();
  const pending = h.translate();
  h.rejectTranslation(new Error("Translation unavailable"));
  await pending;

  assert.equal(h.draftRef.current, h.draft);
  assert.equal(h.updates.length, 0);
  assert.equal(h.draftDirty.current, false);
  assert.deepEqual(h.busy, [true, false]);
  assert.match(h.messages.at(-1), /Translation unavailable/);
});
