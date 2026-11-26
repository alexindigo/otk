// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { servedBuild } from "../../../core/http/served-build.ts";
import { fixture } from "../../support/config.ts";
import { test } from "../../support/resources.ts";

test("served build is a stable hash of the index bytes, or unbundled", async () => {
  const root = await fixture();
  assertEquals(await servedBuild(root), "unbundled");
  const file = join(root, "index.html");
  await Deno.writeTextFile(file, "hello");
  assertEquals(await servedBuild(root), "2cf24dba5fb0a30e");
  assertEquals(await servedBuild(root), "2cf24dba5fb0a30e");
  await Deno.writeTextFile(file, "Hello");
  assertNotEquals(await servedBuild(root), "2cf24dba5fb0a30e");
});
