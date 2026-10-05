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
  assert.match(menu, /https:\/\/github\.com\/Ikepersan\/rill\/tree\/v1\.0\.4/);
  assert.match(menu, /Command::new\("open"\)/);
  assert.match(menu, /package_info\(\)\.version/);
  assert.match(menu, /MenuItem::with_id\(app, "copy", "コピー", true, Some\("CmdOrCtrl\+C"\)\)/);
  assert.doesNotMatch(menu, /PredefinedMenuItem::copy/);
  assert.match(menu, /"copy" => "copy"/);
  assert.match(app, /listen<string>\("rill:\/\/menu-action"/);
  assert.match(app, /new Event\("rill:\/\/copy-request", \{ cancelable: true \}\)/);
  assert.match(app, /<SettingsDialog/);
});

test("all release manifests and source notices agree on version 1.0.4", async () => {
  const [packageJson, packageLock, tauriConfig, cargoToml, cargoLock, menu, agplNotice, thirdPartyNotice] = await Promise.all([
    read("package.json"),
    read("package-lock.json"),
    read("src-tauri/tauri.conf.json"),
    read("src-tauri/Cargo.toml"),
    read("src-tauri/Cargo.lock"),
    read("src-tauri/src/menu.rs"),
    read("AGPL_NOTICE.md"),
    read("THIRD_PARTY_NOTICES.md"),
  ]);

  const version = JSON.parse(packageJson).version;
  const parsedPackageLock = JSON.parse(packageLock);
  assert.equal(version, "1.0.4");
  assert.equal(parsedPackageLock.version, version);
  assert.equal(parsedPackageLock.packages[""].version, version);
  assert.equal(JSON.parse(tauriConfig).version, version);
  assert.match(cargoToml, new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(cargoLock, new RegExp(`\\[\\[package\\]\\]\\nname = "rill"\\nversion = "${version.replaceAll(".", "\\.")}"`));
  const sourceUrl = `https://github.com/Ikepersan/rill/tree/v${version}`;
  assert.match(menu, new RegExp(sourceUrl.replaceAll(".", "\\.")));
  assert.match(agplNotice, new RegExp(sourceUrl.replaceAll(".", "\\.")));
  assert.match(thirdPartyNotice, new RegExp(sourceUrl.replaceAll(".", "\\.")));
});

test("the macOS release pipeline notarizes, verifies, and publishes a checksum", async () => {
  const [releaseScript, checkScript, gitignore, workflow] = await Promise.all([
    read("scripts/release-macos.sh"),
    read("scripts/check-macos-release.sh"),
    read(".gitignore"),
    read(".github/workflows/macos-ci.yml"),
  ]);

  assert.match(releaseScript, /status --porcelain --untracked-files=normal/);
  assert.match(releaseScript, /submodule status --recursive/);
  assert.match(releaseScript, /grep -Eq '\^\[-\+U\]'/);
  assert.match(releaseScript, /notarytool history/);
  assert.match(releaseScript, /notarytool submit/);
  assert.match(releaseScript, /stapler staple/);
  assert.match(releaseScript, /Rill_\$\{RILL_VERSION\}_SHA256SUMS\.txt/);
  assert.match(releaseScript, /shasum -a 256/);
  assert.match(releaseScript, /check-macos-release\.sh/);
  assert.match(checkScript, /CHECKSUM_TARGET/);
  assert.match(checkScript, /shasum -a 256 -c/);
  for (const extension of ["p12", "p8", "cer", "key", "mobileprovision", "provisionprofile"]) {
    assert.match(gitignore, new RegExp(`\\*\\.${extension}`));
  }
  assert.match(workflow, /targets: aarch64-apple-darwin/);
  assert.match(workflow, /npm exec tauri build -- --ci --bundles app --target aarch64-apple-darwin/);
});
