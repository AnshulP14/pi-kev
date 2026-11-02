import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("extension has no machine-specific paths and exposes portable configuration", async () => {
  const source = await readFile(path.join(root, "extensions", "index.ts"), "utf8");
  for (const variable of ["KEV_ROOT", "KEV_PORT", "KEV_MODEL", "KEV_RESULTS_DIR", "KEV_ANYDOC"]) {
    assert.match(source, new RegExp(`process\\.env\\.${variable}`));
  }
  assert.doesNotMatch(source, /\/Users\//);
});

test("package advertises the extension and skill", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi, { extensions: ["./extensions"], skills: ["./skills"] });
});
