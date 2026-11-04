// SPDX-License-Identifier: LGPL-3.0-only
async function inspect(path: string): Promise<void> {
  const info = await Deno.stat(path);
  if (info.isDirectory) {
    for await (const entry of Deno.readDir(path)) {
      if (["tests", "node_modules", "dist"].includes(entry.name)) continue;
      await inspect(`${path}/${entry.name}`);
    }
  } else if (/\.tsx?$/.test(path)) {
    if (/__otk|testOnly|test-only/.test(await Deno.readTextFile(path))) {
      throw new Error(`Product test hook: ${path}`);
    }
  }
}
for (
  const path of ["main.ts", "application.ts", "core", "packages", "web/src"]
) await inspect(path);
console.info("No product test hooks");
