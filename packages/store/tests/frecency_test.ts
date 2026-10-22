// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Frecency, OtkDb } from "@otk/store";
import { fixture, frecencyOptions, migrations } from "./support.ts";

test("frecency stores canonical project paths, increments and survives reopen", async () => {
  const root = await fixture(),
    db = new OtkDb(root, migrations),
    store = new Frecency(db, frecencyOptions);
  store.bump("/project", "README.md");
  store.bump("/project", "./README.md");
  assertEquals(store.list("/project")[0].score, 2);
  assertEquals(store.list("/project")[0].path, "/project/README.md");
  db.close();
  const next = new OtkDb(root, migrations);
  try {
    assertEquals(
      new Frecency(next, frecencyOptions).list("/project")[0].score,
      2,
    );
    assertEquals(new Frecency(next, frecencyOptions).list("/other"), []);
  } finally {
    next.close();
  }
});

test("frecency persists at most 1000 canonical entries across projects", async () => {
  const root = await fixture(),
    db = new OtkDb(root, migrations),
    store = new Frecency(db, frecencyOptions);
  try {
    for (let i = 0; i < 1005; i++) {
      store.bump(i % 2 ? "/project-a" : "/project-b", `file-${i}`);
    }
    assertEquals(
      Number(
        db.connection.prepare("SELECT count(*) AS n FROM frecency").get()!.n,
      ),
      1000,
    );
    assert(
      store.list("/project-b").some((row) =>
        row.path === "/project-b/file-1004"
      ),
    );
  } finally {
    db.close();
  }
});

test("frecency rejects oversized keys before persisting them", async () => {
  const root = await fixture(),
    db = new OtkDb(root, migrations),
    store = new Frecency(db, frecencyOptions);
  try {
    for (const key of ["x".repeat(4097), "", "nul\0key"]) {
      assertThrows(() => store.bump("/project", key), Error);
      assertThrows(() => store.list(key), Error);
    }
    assertEquals(
      Number(
        db.connection.prepare("SELECT count(*) AS n FROM frecency").get()!.n,
      ),
      0,
    );
  } finally {
    db.close();
  }
});
