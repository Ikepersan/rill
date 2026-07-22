import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("papers move to recoverable Rill Trash instead of the macOS Trash", async () => {
  const [backend, commands, frontend] = await Promise.all([
    read("src-tauri/src/library.rs"),
    read("src-tauri/src/lib.rs"),
    read("desktop/src/App.tsx"),
  ]);
  assert.match(backend, /"Trash"/);
  assert.match(backend, /move_paper_to_rill_trash/);
  assert.match(backend, /restore_trashed_paper/);
  assert.match(backend, /delete_trashed_paper_permanently/);
  assert.doesNotMatch(backend, /trash::delete|macOSのゴミ箱/);
  assert.match(commands, /library::list_trashed_papers/);
  assert.match(frontend, /Rillのゴミ箱へ移動/);
  assert.match(frontend, /Finderで開く/);
  assert.match(frontend, /PDF・Markdown・注釈は復元できなくなります/);
});
