// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { OtkDb } from "@otk/store";
import { test } from "../../../tests/support/resources.ts";
import { fixture } from "./support.ts";

test("store rejects the unresolved empty path before creating files in the current directory", async () => {
  const root = await fixture(), previous = Deno.cwd();
  try {
    Deno.chdir(root);
    assertThrows(
      () => new OtkDb("", []),
      TypeError,
      "State path must not be empty",
    );
    assertEquals([...Deno.readDirSync(root)], []);
    const db = new OtkDb("relative-state", []);
    db.close();
    assertEquals(
      Deno.statSync(join(root, "relative-state", "otk.db")).isFile,
      true,
    );
  } finally {
    Deno.chdir(previous);
  }
});
