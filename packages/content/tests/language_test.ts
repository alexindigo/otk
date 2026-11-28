// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fileLanguage } from "@otk/content";

Deno.test("file language uses the native filename and shared aliases", () => {
  for (
    const [path, expected] of [
      ["a.mjs", "js"],
      ["a.py", "python"],
      ["a.sh", "bash"],
      ["a.ts", "ts"],
      ["README", undefined],
    ] as const
  ) assertEquals(fileLanguage(path), expected);
});
