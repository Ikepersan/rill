import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("draft saves are serialized, revision guarded, and flushed before window close", async () => {
  const [app, repository] = await Promise.all([
    read("desktop/src/App.tsx"),
    read("desktop/src/reader-engine/AnnotationRepository.ts"),
  ]);

  assert.match(app, /latestRevisionByPaper/);
  assert.match(app, /draftSaveQueue\.current\.then/);
  assert.match(app, /latestRevisionByPaper\.current\.get\(saved\.id\).*revision/s);
  assert.match(app, /onCloseRequested/);
  assert.match(app, /event\.preventDefault\(\)/);
  assert.match(app, /await flushPendingEdits\(\)/);
  assert.match(app, /await readerFlush\.current\?\.\(\)/);
  assert.match(repository, /flush\(\)/);
});

test("failed Trash moves retain recovery data unless every file is restored", async () => {
  const backend = await read("src-tauri/src/library.rs");

  assert.match(backend, /rollback_moved_files/);
  assert.match(backend, /move_was_fully_rolled_back/);
  assert.match(backend, /復旧確認のため退避先を削除していません/);
  assert.match(backend, /failed_multi_file_move_restores_every_moved_file/);
});

test("library access is authorized natively and rejects symlink escapes", async () => {
  const [backend, commands, frontend, config] = await Promise.all([
    read("src-tauri/src/library.rs"),
    read("src-tauri/src/lib.rs"),
    read("desktop/src/App.tsx"),
    read("src-tauri/tauri.conf.json"),
  ]);

  assert.match(backend, /AUTHORIZED_LIBRARY_ROOT/);
  assert.match(backend, /choose_library_root/);
  assert.match(backend, /migrate_library_root/);
  assert.match(backend, /canonical_existing\.starts_with\(&canonical_root\)/);
  assert.match(backend, /safe_join_rejects_symlinks_that_escape_the_library/);
  assert.match(commands, /library::restore_library_root/);
  assert.match(frontend, /await flushPendingEdits\(\);\s+const selectedFolder = await invoke<string \| null>\("choose_library_root"\)/);
  assert.doesNotMatch(backend, /pub fn write_citation_preset\(path:/);
  assert.doesNotMatch(backend, /pub fn read_citation_preset\(path:/);
  assert.notEqual(JSON.parse(config).app.security.csp, null);
});

test("all app exit paths flush edits before the native process exits", async () => {
  const [frontend, backend, menu] = await Promise.all([
    read("desktop/src/App.tsx"),
    read("src-tauri/src/lib.rs"),
    read("src-tauri/src/menu.rs"),
  ]);

  assert.match(menu, /MenuItem::with_id\(app, "quit"/);
  assert.doesNotMatch(menu, /PredefinedMenuItem::quit/);
  assert.match(frontend, /payload === "quit".*requestAppQuit/s);
  assert.match(frontend, /onCloseRequested[\s\S]*event\.preventDefault\(\)[\s\S]*requestAppQuit/);
  assert.match(frontend, /await flushPendingEdits\(\);\s+await invoke\("exit_after_flush"\)/);
  assert.match(backend, /RunEvent::ExitRequested/);
  assert.match(backend, /ALLOW_EXIT_AFTER_FLUSH/);
});

test("durable saves fsync temporary files and metadata enrichment preserves newer edits", async () => {
  const [frontend, backend] = await Promise.all([
    read("desktop/src/App.tsx"),
    read("src-tauri/src/library.rs"),
  ]);

  assert.match(backend, /fn write_synced_then_rename/);
  assert.match(backend, /file\.sync_all\(\)/);
  assert.match(backend, /write_synced_then_rename\(\s*&temporary,\s*&config/s);
  assert.match(backend, /write_synced_then_rename\(\s*&temporary,\s*&note_path/s);
  assert.match(backend, /write_synced_then_rename\(\s*&temporary,\s*&path/s);
  assert.match(frontend, /currentRevision !== requestedRevision/);
  assert.match(frontend, /取得中に行った編集を優先/);
  assert.match(frontend, /savedPapers\.push\(await invoke<Paper>\("save_paper", \{ root, paper: enriched \}\)\)/);
  assert.match(frontend, /skippedEditedCount/);
});

test("stable paper identities survive external PDF renames and Trash round trips", async () => {
  const backend = await read("src-tauri/src/library.rs");

  assert.match(backend, /struct LibraryIndex/);
  assert.match(backend, /\.rill\/index\.json/);
  assert.match(backend, /pdf_sha256/);
  assert.match(backend, /external_pdf_rename_keeps_identity_note_and_annotations/);
  assert.match(backend, /duplicate_pdf_hashes_relink_only_the_missing_path/);
  assert.match(backend, /missing_or_corrupt_index_is_rebuilt_from_frontmatter/);
  assert.match(backend, /newer_index_version_is_not_overwritten/);
  assert.match(backend, /duplicate_frontmatter_ids_do_not_rewrite_notes/);
});
