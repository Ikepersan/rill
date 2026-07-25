import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../desktop/src/App.tsx", import.meta.url), "utf8");

test("CSL template names can be cleared while editing and regain a default on commit", () => {
  assert.match(source, /const \[presetNameDraft, setPresetNameDraft\] = useState\(presetName \?\? ""\)/);
  assert.match(source, /onChange=\{\(event\) => setPresetNameDraft\(event\.target\.value\)\}/);
  assert.match(source, /onBlur=\{commitPresetName\}/);
  assert.match(source, /const nextName = name\.trim\(\) \|\| `新しいテンプレート \$\{fallbackIndex\}`/);
});
