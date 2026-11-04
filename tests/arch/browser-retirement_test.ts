// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { dependencySpecifiers } from "./analysis.ts";
import {
  oldBrowserConsumers,
  retiredBrowserImport,
  retiredBrowserPaths,
} from "./browser-retirement.ts";

Deno.test("retired browser helpers have no consumers or source files", async () => {
  assertEquals(await oldBrowserConsumers(), []);
  for (const path of retiredBrowserPaths) {
    let exists = true;
    try {
      await Deno.stat(new URL("../../" + path, import.meta.url));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      exists = false;
    }
    assertEquals(exists, false, `Retired browser helper restored: ${path}`);
  }
});

Deno.test("browser retirement rejects static, type, dynamic and reexport dependencies", () => {
  for (const path of retiredBrowserPaths) {
    const specifier = "../support/./" + path.split("/").at(-1);
    for (
      const source of [
        `import { driver } from ${JSON.stringify(specifier)};`,
        `import type { Driver } from ${JSON.stringify(specifier)};`,
        `export * from ${JSON.stringify(specifier)};`,
        `const driver = import(${JSON.stringify(specifier)});`,
        `type Driver = import(${JSON.stringify(specifier)}).Driver;`,
      ]
    ) {
      assertEquals(
        dependencySpecifiers(source).map((dependency) =>
          dependency && retiredBrowserImport("tests/reuse/probe.ts", dependency)
        ),
        [true],
      );
    }
  }
  assertEquals(
    retiredBrowserImport("tests/browser/probe.ts", "./fixtures/evidence.ts"),
    false,
  );
});
