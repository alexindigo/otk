// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources } from "./analysis.ts";

Deno.test("browser scrollbar paint belongs only to ScrollRegion", async () => {
  const violations: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (path === "packages/ui/components/ScrollRegion.css") continue;
    if (/scrollbar-(?:width|color)|::-webkit-scrollbar/.test(text)) {
      violations.push(path);
    }
  }
  assertEquals(violations, []);
});
Deno.test("visible scroll boundaries mount the shared scrollbar owner", async () => {
  const text = await Deno.readTextFile(
    new URL("../../packages/ui/components/ScrollRegion.tsx", import.meta.url),
  );
  assert(text.includes("subscribeSnapshot"));
  assert(text.includes('role="scrollbar"'));
  assert(text.includes("setPointerCapture"));
  for (const [path, source] of await productionSources()) {
    if (
      !path.startsWith("packages/ui/") || path.endsWith("/ScrollRegion.tsx")
    ) continue;
    assert(
      !/scrollRegion\s*\(/.test(source),
      `${path}: class-only scrollbar bypass`,
    );
  }
});
