import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("macOS menu exposes settings, primary library actions, and version help", async () => {
  const [menu, app] = await Promise.all([
    read("src-tauri/src/menu.rs"),
    read("desktop/src/App.tsx"),
  ]);

  assert.match(menu, /"設定…"/);
  assert.match(menu, /"CmdOrCtrl\+,"/);
  assert.match(menu, /"PDFを追加…"/);
  assert.match(menu, /"Rillのバージョン"/);
  assert.match(menu, /"ライセンスとソースコード…"/);
  assert.match(menu, /"open-source-and-license"/);
  assert.match(menu, /https:\/\/github\.com\/Ikepersan\/rill\/tree\/v0\.8\.0/);
  assert.match(menu, /Command::new\("open"\)/);
  assert.match(menu, /package_info\(\)\.version/);
  assert.match(app, /listen<string>\("rill:\/\/menu-action"/);
  assert.match(app, /<SettingsDialog/);
});

test("all release manifests agree on version 0.8.0", async () => {
  const [packageJson, tauriConfig, cargoToml] = await Promise.all([
    read("package.json"),
    read("src-tauri/tauri.conf.json"),
    read("src-tauri/Cargo.toml"),
  ]);

  assert.equal(JSON.parse(packageJson).version, "0.8.0");
  assert.equal(JSON.parse(tauriConfig).version, "0.8.0");
  assert.match(cargoToml, /^version = "0\.8\.0"$/m);
});
