import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../desktop/src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../desktop/src/styles.css", import.meta.url), "utf8");
const library = await readFile(new URL("../src-tauri/src/library.rs", import.meta.url), "utf8");
const tauri = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

test("folder context menu supports stable Control-click and rename", () => {
  assert.match(app, /window\.addEventListener\("pointerdown", closeMenu\)/);
  assert.doesNotMatch(app, /window\.addEventListener\("click", closeMenu\)/);
  assert.match(app, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(app, />名前を変更…<\/button>/);
  assert.match(app, /invoke<string>\("rename_collection"/);
  assert.match(app, /<h2>フォルダ名を変更<\/h2>/);
});

test("folder hierarchy can be changed by pointer drag without unsafe merging", () => {
  assert.match(app, /data-folder-reparent-target=\{collection\}/);
  assert.match(app, /beginFolderDrag\(event, collection\)/);
  assert.match(app, /invoke<string>\("move_collection"/);
  assert.match(styles, /\.folder-drag-preview/);
  assert.match(styles, /\.collection-button\.hierarchy-drop-target/);
  assert.match(library, /pub fn move_collection/);
  assert.match(library, /pub fn rename_collection/);
  assert.match(library, /フォルダを自分自身の中へ移動することはできません/);
  assert.match(library, /はすでに存在します。別の名前を選んでください/);
  assert.match(tauri, /library::rename_collection/);
  assert.match(tauri, /library::move_collection/);
});

test("folder mutations save drafts first and prevent overlapping or stale clicks", () => {
  const moveStart = app.indexOf("async function applyCollectionMove");
  const moveFlush = app.indexOf("await flushPendingEdits()", moveStart);
  const moveInvoke = app.indexOf('invoke<string>("move_collection"', moveStart);
  assert.ok(moveStart >= 0 && moveFlush > moveStart && moveInvoke > moveFlush);

  const renameStart = app.indexOf("async function renameLibraryFolder");
  const renameFlush = app.indexOf("await flushPendingEdits()", renameStart);
  const renameInvoke = app.indexOf('invoke<string>("rename_collection"', renameStart);
  assert.ok(renameStart >= 0 && renameFlush > renameStart && renameInvoke > renameFlush);

  assert.match(app, /collectionMutationInFlight\.current/);
  assert.match(app, /suppressFolderClickUntil\.current = window\.performance\.now\(\) \+ 100/);
  assert.match(app, /if \(parent === currentParent\) return null/);
  assert.match(app, /applyCollectionPathRemap\(collection, moved\)[\s\S]*if \(!await loadLibrary\(root, false\)\)/);
  assert.match(app, /フォルダは移動しましたが、一覧を再読込できませんでした/);
});
