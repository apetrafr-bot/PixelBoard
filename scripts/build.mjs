import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

export async function buildSite(outDir = resolve("dist")) {
  // Keep server-only config.php intact when rebuilding an existing deployment.
  await build({ build: { outDir, emptyOutDir: false } });
  const apiDir = resolve(outDir, "api");
  await mkdir(apiDir, { recursive: true });
  for (const file of ["index.php", "lib.php", ".htaccess"]) {
    await copyFile(resolve("api", file), resolve(apiDir, file));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSite();
}
