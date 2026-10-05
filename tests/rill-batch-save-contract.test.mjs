import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../desktop/src/App.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "App");
const functionNames = new Set([
  "parseTags", "referenceOrderStorageKey", "currentPaperSnapshot", "reservePaperRevision",
  "enqueueDraftSave", "flushPendingEdits", "persistPaperMutation", "persistPaperBatch",
  "markSelectedPapersAsRead", "addSelectedPapersToReferences", "addTagsToReferences", "removeAllReferences",
]);
// Keep the real mutation, queue and retry handlers; replace only UI/native boundaries.
const handlers = [...parsed.statements, ...app.body.statements]
  .filter((node) => ts.isFunctionDeclaration(node) && functionNames.has(node.name?.text))
  .map((node) => node.getText(parsed)).join("\n");
const javascript = ts.transpileModule(handlers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const bindHandlers = new Function("context", `
  const { root, isTauri, selectedIds, papersRef, draftRef, draftDirty, draftRevision,
    latestRevisionByPaper, queuedSaveByPaper, draftSaveQueue, failedDraftSaves, autoSaveTimer,
    readerFlush, setPapers, setDraft, setSaveState, setToast, setBusy, setReferenceOrder,
    localStorage, window, invoke } = context;
  ${javascript}
  return { markSelectedPapersAsRead, addSelectedPapersToReferences,
    addTagsToReferences, removeAllReferences, flushPendingEdits };
`);

function createHarness({ references = false, confirmed = true, isTauri = true, save } = {}) {
  const papers = ["a", "b", "c", "d"].map((id) => ({
    id, title: `Paper ${id}`, authors: [], tags: ["existing"], status: "未読",
    isReference: references || id === "d", noteRevision: "original",
  }));
  const papersRef = { current: papers };
  const failedDraftSaves = { current: new Map() };
  const state = {
    referenceOrder: references ? ["d", "b", "c", "a"] : ["missing", "d"],
    storage: new Map(), busy: [], messages: [], confirmations: [], calls: [], failIds: new Set(),
  };
  const api = bindHandlers({
    root: "/library", isTauri, selectedIds: new Set(["c", "a", "b"]), papersRef,
    draftRef: { current: null }, draftDirty: { current: false }, draftRevision: { current: 0 },
    latestRevisionByPaper: { current: new Map() }, queuedSaveByPaper: { current: new Map() },
    draftSaveQueue: { current: Promise.resolve() }, failedDraftSaves,
    autoSaveTimer: { current: 0 }, readerFlush: { current: null },
    setPapers: (next) => { papersRef.current = typeof next === "function" ? next(papersRef.current) : next; },
    setDraft: () => {}, setSaveState: () => {},
    setToast: (message) => state.messages.push(message),
    setBusy: (value) => state.busy.push(value),
    setReferenceOrder: (update) => { state.referenceOrder = update(state.referenceOrder); },
    localStorage: { setItem: (key, value) => state.storage.set(key, value) },
    window: {
      clearTimeout: () => {},
      confirm: (message) => { state.confirmations.push(message); return confirmed; },
    },
    invoke: async (command, { paper }) => {
      assert.equal(command, "save_paper");
      state.calls.push(structuredClone(paper));
      if (save) await save(paper);
      if (state.failIds.has(paper.id)) throw new Error(`Cannot save ${paper.id}`);
      return { ...paper, noteRevision: `saved-${paper.id}` };
    },
  });
  return {
    api, state, papersRef, failedDraftSaves,
    targets: () => ["c", "a", "b"].map((id) => papersRef.current.find((paper) => paper.id === id)),
  };
}

const operations = [
  {
    name: "mark read", references: false,
    run: (h) => h.api.markSelectedPapersAsRead(), empty: (h) => h.api.markSelectedPapersAsRead([]),
    order: ["a", "b", "c"], referenceOrder: ["missing", "d"], field: "status", value: "読了",
    success: "3件を読了にしました", failure: "3件を読了に変更、1件は保存待ちです",
    emptyMessage: "選択した文献はすべて読了です",
  },
  {
    name: "add references", references: false,
    run: (h) => h.api.addSelectedPapersToReferences(), empty: (h) => h.api.addSelectedPapersToReferences([]),
    order: ["c", "a", "b"], referenceOrder: ["d", "c", "a", "b"], field: "isReference", value: true,
    success: "3件を参考文献に追加しました", failure: "3件を参考文献に追加、1件は保存待ちです",
    emptyMessage: "選択した文献はすべて参考文献に追加済みです", storesOrder: true,
  },
  {
    name: "add tags", references: true,
    run: (h) => h.api.addTagsToReferences(h.targets(), "#new #existing #new"),
    empty: (h) => h.api.addTagsToReferences([], "#new"),
    order: ["c", "a", "b"], referenceOrder: ["d", "b", "c", "a"], field: "tags", value: ["existing", "new"],
    success: "3件に2個のタグを追加しました", failure: "3件にタグを追加、1件は保存待ちです",
    result: true, emptyResult: false,
  },
  {
    name: "remove references", references: true,
    run: (h) => h.api.removeAllReferences(h.targets()), empty: (h) => h.api.removeAllReferences([]),
    order: ["c", "a", "b"], referenceOrder: ["d"], field: "isReference", value: false,
    success: "3件を参考文献から外しました", failure: "3件を参考文献から解除、1件は保存待ちです",
    storesOrder: true,
  },
];

for (const operation of operations) {
  for (const fails of [false, true]) {
    test(`${operation.name} preserves order, result and notification (partial failure: ${fails})`, async () => {
      const h = createHarness({ references: operation.references });
      if (fails) h.state.failIds.add("a");
      const result = await operation.run(h);

      assert.equal(result, operation.result);
      assert.deepEqual(h.state.calls.map((paper) => paper.id), operation.order);
      assert.deepEqual(h.state.busy, [true, false]);
      assert.equal(h.state.messages.at(-1), fails ? operation.failure : operation.success);
      assert.deepEqual(h.state.referenceOrder, operation.referenceOrder);
      if (operation.storesOrder) {
        assert.equal(h.state.storage.get("rill-reference-order:/library"), JSON.stringify(operation.referenceOrder));
      } else {
        assert.equal(h.state.storage.size, 0);
      }
      for (const paper of h.targets()) assert.deepEqual(paper[operation.field], operation.value);
      assert.equal(h.papersRef.current.find((paper) => paper.id === "d").noteRevision, "original");

      if (operation.name === "remove references") {
        assert.deepEqual(h.state.confirmations, ["3件を参考文献から外しますか？\nPDFとMarkdownはLibraryに残ります。"]);
      } else {
        assert.deepEqual(h.state.confirmations, []);
      }
      assert.deepEqual([...h.failedDraftSaves.current.keys()], fails ? ["a"] : []);
      if (fails) {
        assert.deepEqual(h.failedDraftSaves.current.get("a").snapshot[operation.field], operation.value);
        h.state.failIds.clear();
        await h.api.flushPendingEdits();
        assert.deepEqual(h.state.calls.map((paper) => paper.id), [...operation.order, "a"]);
        assert.equal(h.failedDraftSaves.current.size, 0);
      }
    });
  }

  test(`${operation.name} with no targets does not save or change busy/order/confirmation`, async () => {
    const h = createHarness({ references: operation.references });
    const originalOrder = [...h.state.referenceOrder];
    assert.equal(await operation.empty(h), operation.emptyResult);
    assert.deepEqual(h.state.calls, []);
    assert.deepEqual(h.state.busy, []);
    assert.deepEqual(h.state.confirmations, []);
    assert.deepEqual(h.state.referenceOrder, originalOrder);
    assert.equal(h.state.storage.size, 0);
    assert.equal(h.state.messages.at(-1), operation.emptyMessage);
  });
}

test("a pending save holds the next paper and keeps busy until the batch completes", async () => {
  let releaseFirst;
  let started;
  const firstSave = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const h = createHarness({ save: async (paper) => {
    if (paper.id === "a") { started(); await firstSave; }
  } });
  const pending = h.api.markSelectedPapersAsRead();
  await firstStarted;
  assert.deepEqual(h.state.calls.map((paper) => paper.id), ["a"]);
  assert.deepEqual(h.state.busy, [true]);
  assert.deepEqual(h.papersRef.current.slice(0, 3).map((paper) => paper.status), ["読了", "未読", "未読"]);

  releaseFirst();
  await pending;
  assert.deepEqual(h.state.calls.map((paper) => paper.id), ["a", "b", "c"]);
  assert.deepEqual(h.state.busy, [true, false]);
});

test("cancelling reference removal leaves papers, order and storage untouched", async () => {
  const h = createHarness({ references: true, confirmed: false });
  const before = structuredClone(h.papersRef.current);
  await h.api.removeAllReferences(h.targets());
  assert.deepEqual(h.papersRef.current, before);
  assert.deepEqual(h.state.referenceOrder, ["d", "b", "c", "a"]);
  assert.equal(h.state.storage.size, 0);
  assert.equal(h.state.confirmations.length, 1);
  assert.deepEqual(h.state.calls, []);
  assert.deepEqual(h.state.busy, []);
  assert.deepEqual(h.state.messages, []);
});

test("read papers and unknown IDs are excluded from the read batch", async () => {
  const h = createHarness();
  h.papersRef.current[1].status = "読了";
  await h.api.markSelectedPapersAsRead(["c", "missing", "b", "a"]);
  assert.deepEqual(h.state.calls.map((paper) => paper.id), ["a", "c"]);
  assert.equal(h.state.messages.at(-1), "2件を読了にしました");
});

test("existing references and unknown IDs are excluded while requested order is kept", async () => {
  const h = createHarness();
  h.papersRef.current[1].isReference = true;
  await h.api.addSelectedPapersToReferences(["c", "missing", "b", "a"]);
  assert.deepEqual(h.state.calls.map((paper) => paper.id), ["c", "a"]);
  assert.deepEqual(h.state.referenceOrder, ["d", "b", "c", "a"]);
  assert.equal(h.state.messages.at(-1), "2件を参考文献に追加しました");
});

test("blank tags do not start a batch", async () => {
  const h = createHarness({ references: true });
  assert.equal(await h.api.addTagsToReferences(h.targets(), " # , ＃ "), false);
  assert.deepEqual(h.state.calls, []);
  assert.deepEqual(h.state.busy, []);
  assert.deepEqual(h.state.messages, []);
});

test("preview batches keep the preview notification and avoid native writes", async () => {
  const h = createHarness({ isTauri: false });
  await h.api.markSelectedPapersAsRead();
  assert.deepEqual(h.state.calls, []);
  assert.deepEqual(h.state.busy, [true, false]);
  for (const paper of h.targets()) assert.equal(paper.status, "読了");
  assert.equal(h.state.messages.at(-1), "3件を読了にしました（プレビュー）");
});
