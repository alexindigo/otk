// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestProgress } from "../../../core/digest/progress.ts";
Deno.test("worker progress counts bounded discoveries and updates only the affected scope", () => {
  let now = 1000;
  const progress = new DigestProgress("one", () => now);
  progress.row("a", "/a", false);
  progress.row("b", "/b", true, 12);
  assertEquals(progress.values()[0].eligible, null);
  progress.complete();
  assertEquals(progress.values()[0].eligible, 2);
  now = 2000;
  progress.row("a", "/a", true, 20);
  progress.chunk("/a", 50);
  const global = progress.values()[0];
  assertEquals([
    global.completed,
    global.queued,
    global.messages,
    global.chunks,
    global.activeMs,
  ], [2, 0, 32, 1, 50]);
  assertEquals(
    progress.values().find((value) => value.directory === "/b")?.advanced,
    1000,
  );
  now = 3000;
  progress.row("a", "/a", true, 20);
  assertEquals(progress.values()[0].advanced, 2000);
  assertEquals(new DigestProgress("two").values()[0].completed, 0);
  progress.enumerate();
  assertEquals(progress.values()[0].eligible, null);
  progress.row("c", "/c", false);
  assertEquals(progress.values()[0].phase, "summaries");
  assertEquals(progress.values()[0].eligible, null);
  progress.complete();
  assertEquals(progress.values()[0].eligible, 3);
});
