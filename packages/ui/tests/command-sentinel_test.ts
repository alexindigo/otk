// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";

Deno.test("one randomly named registration reaches the real Palette and slash completion source", async () => {
  // Native bundler plugins belong to this child, not the ordinary unit runner.
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      new URL("command-sentinel-browser.ts", import.meta.url).pathname,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  assertEquals(result.code, 0);
});
