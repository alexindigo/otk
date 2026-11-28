// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assertEquals } from "@std/assert";
import { Checkouts, checkoutsMigrations, OtkDb } from "@otk/store";

Deno.test("checkout remote migration is additive and preserves first observation", async () => {
  const path = await Deno.makeTempDir();
  const v3 = {
    ...checkoutsMigrations,
    migrations: checkoutsMigrations.migrations.slice(0, 3),
  };
  const root = "/clone";
  const record = {
    source: "native",
    repoID: "id",
    scope: root,
    canonicalRoot: root,
    leafDirectory: root,
    kind: "checkout",
    availability: "present",
    proven: true,
    repository: root,
  } as const;
  let db = new OtkDb(path, [v3], { busyms: 0 });
  try {
    new Checkouts(db).save([record]);
    db.close();
    db = new OtkDb(path, [checkoutsMigrations], { busyms: 0 });
    let store = new Checkouts(db);
    assertEquals(store.list(), [record]);
    assertEquals(
      db.connection.prepare(
        "SELECT version FROM otk_migrations WHERE feature='checkouts' AND version=4",
      ).get()?.version,
      4,
    );
    assertEquals(store.remotes(), []);
    assertEquals(store.anchors(), []);
    const remote = {
      repository: root,
      remote: "github.com/org/repo",
      owner: "org",
      firstSeen: 1,
      readAt: 1,
    };
    store.save([], undefined, [remote], [{
      remote: remote.remote,
      repository: root,
    }]);
    store.save([], undefined, [{
      repository: root,
      remote: null,
      firstSeen: 2,
      readAt: 2,
    }]);
    db.close();
    db = new OtkDb(path, [checkoutsMigrations], { busyms: 0 });
    store = new Checkouts(db);
    assertEquals(store.list(), [record]);
    assertEquals(store.remotes(), [{
      repository: root,
      remote: null,
      firstSeen: 1,
      readAt: 2,
    }]);
    assertEquals(store.anchors(), [{
      remote: remote.remote,
      repository: root,
    }]);
  } finally {
    db.close();
    await Deno.remove(path, { recursive: true });
  }
});
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
