import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path, encoding) => readFile(new URL(path, root), encoding);

test("macOS assets use the adopted Rill meander mark", async () => {
  const [source, desktopSource, app, background, backgroundPng, config, icns] = await Promise.all([
    read("src-tauri/icons/rill-meander.svg", "utf8"),
    read("desktop/rill-icon.svg", "utf8"),
    read("desktop/src/App.tsx", "utf8"),
    read("src-tauri/images/dmg-background.svg", "utf8"),
    read("src-tauri/images/dmg-background.png"),
    read("src-tauri/tauri.conf.json", "utf8"),
    read("src-tauri/icons/icon.icns"),
  ]);

  const expectedPath = "M6 8c10 0 10 8 2 8s0 8 18 8";
  assert.match(source, new RegExp(expectedPath.replaceAll(" ", "\\s+")));
  assert.match(source, /stroke="#2E6E8E"/);
  assert.match(source, /stroke-width="3\.5"/);
  assert.match(source, /fill="#F7F6F3"/);
  assert.doesNotMatch(source, /<text\b/);

  assert.match(desktopSource, new RegExp(expectedPath.replaceAll(" ", "\\s+")));
  assert.doesNotMatch(desktopSource, />R<\/text>/);
  assert.match(app, new RegExp(expectedPath.replaceAll(" ", "\\s+")));
  assert.doesNotMatch(app, /className="rill-mark[^"]*">R</);

  assert.match(background, /stroke="#2E6E8E"/);
  assert.match(background, /fill="#F7F6F3"/);
  assert.match(background, /width="660" height="400"/);
  assert.doesNotMatch(background, />R<\/text>/);
  assert.doesNotMatch(background, /M270 220H379|m368 208 14 12/);
  assert.equal(backgroundPng.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(backgroundPng.readUInt32BE(16), 660);
  assert.equal(backgroundPng.readUInt32BE(20), 400);

  const icons = JSON.parse(config).bundle.icon;
  for (const size of ["32x32.png", "64x64.png", "128x128.png", "256x256.png", "512x512.png", "1024x1024.png"]) {
    assert.ok(icons.includes(`icons/${size}`), `${size} must be bundled`);
  }
  assert.ok(icons.includes("icons/icon.icns"));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
});
