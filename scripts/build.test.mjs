import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSite } from "./build.mjs";

test("build packages only API runtime and preserves server configuration", async () => {
  const output = await mkdtemp(join(tmpdir(), "pixelboard-build-"));
  try {
    await buildSite(output);
    assert.deepEqual((await readdir(join(output, "api"))).sort(), [".htaccess", "index.php", "lib.php"]);
    for (const file of ["index.php", "lib.php", ".htaccess"]) {
      assert.equal(await readFile(join(output, "api", file), "utf8"), await readFile(join("api", file), "utf8"));
    }
    await mkdir(join(output, "api"), { recursive: true });
    await writeFile(join(output, "api", "config.php"), "TEST CONFIG SENTINEL");
    await buildSite(output);
    assert.equal(await readFile(join(output, "api", "config.php"), "utf8"), "TEST CONFIG SENTINEL");
    assert.ok((await readFile(join(output, "index.html"), "utf8")).includes("profile-button"));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
