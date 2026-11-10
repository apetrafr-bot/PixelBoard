import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
function load(name, context) {
  const start = source.indexOf(`function ${name}(`);
  vm.runInContext(source.slice(start, source.indexOf("\nfunction ", start + 1)), context);
}

test("image rotation stays on 90° steps and survives negative or overflowing turns", () => {
  const context = vm.createContext({});
  load("normalizedImageRotation", context);
  const normalize = context.normalizedImageRotation;
  assert.equal(normalize(0), 0);
  assert.equal(normalize(90), 90);
  assert.equal(normalize(180), 180);
  assert.equal(normalize(270), 270);
  assert.equal(normalize(360), 0);
  assert.equal(normalize(-90), 270);
  assert.equal(normalize(450), 90);
  assert.equal(normalize(89), 90);
  assert.equal(normalize(undefined), 0);
  assert.equal(normalize(Number.NaN), 0);
  assert.equal(normalize("270"), 270);
});
