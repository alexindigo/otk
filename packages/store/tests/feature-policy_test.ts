// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { OtkDb } from "../db.ts";
import { Frecency, frecencyMigrations } from "../features/frecency.ts";
import { tempDir, test } from "../../../tests/support/resources.ts";

test("user-store busy admission is supplied by its composition", async () => {
  const path = await tempDir("policy-");
  const db = new OtkDb(path, [], { busyms: 7 });
  try {
    assertEquals(
      db.connection.prepare("PRAGMA busy_timeout").get()!.timeout,
      7,
    );
  } finally {
    db.close();
  }
});

test("frecency validates the supplied native path bound before canonicalization", async () => {
  const db = new OtkDb(await tempDir("path-policy-"), [frecencyMigrations], {
    busyms: 0,
  });
  try {
    const error = new Error("Path policy");
    const files = new Frecency(db, { maxLength: 10, invalid: () => error });
    assertThrows(
      () => files.bump("/project", "way-too-long"),
      Error,
      "Path policy",
    );
    assertEquals(files.list("/project"), []);
  } finally {
    db.close();
  }
});
