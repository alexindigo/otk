// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assertEquals } from "@std/assert";
import { Checkouts, checkoutsMigrations, OtkDb } from "@otk/store";
import { fixture } from "./support.ts";

test("checkout history keeps a discovered repository across reopen", async () => {
  const path = await fixture();
  const row = {
    source: "native",
    repoID: "repo",
    scope: "/repo.review",
    canonicalRoot: "/repo.review",
    leafDirectory: "/repo.review",
    kind: "worktree" as const,
    availability: "removed" as const,
    proven: true,
  };
  let db = new OtkDb(path, [checkoutsMigrations], { busyms: 0 });
  new Checkouts(db).save([row, {
    ...row,
    scope: "/repo.review/src",
    repository: "/repo",
  }]);
  db.close();
  db = new OtkDb(path, [checkoutsMigrations], { busyms: 0 });
  try {
    assertEquals(new Checkouts(db).list(), [row, {
      ...row,
      scope: "/repo.review/src",
      repository: "/repo",
    }]);
  } finally {
    db.close();
  }
});
