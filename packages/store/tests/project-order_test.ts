// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { OtkDb, ProjectOrderStore, projectsMigrations } from "@otk/store";
import { fixture } from "./support.ts";
import { test } from "../../../tests/support/resources.ts";

test("project order persists dense ranks and aliases across reopen", async () => {
  const dir = await fixture();
  let db = new OtkDb(dir, [projectsMigrations], { busyms: 5000 });
  try {
    const order = new ProjectOrderStore(db);
    const a = order.create("u", "/a");
    const b = order.create("u", "/b", "repo");
    const c = order.create("u", "/c");
    assertEquals(order.list("u").map(({ id }) => id), [a, b, c]);
    order.attach("u", "/child", b);
    order.attach("u", "/b-new", b);
    order.reroot("u", b, "/b-new");
    order.move("u", c, { before: a });
    order.move("u", c, { after: b });
    order.move("u", b, { before: a });
    assertThrows(() => order.move("u", b, { after: b }), Error, "itself");
    assertThrows(
      () => order.move("u", b, { after: "unknown" }),
      Error,
      "Unknown project",
    );
    assertThrows(
      () => order.move("other", b, { after: a }),
      Error,
      "Unknown project",
    );
    assertEquals(
      db.connection.prepare("SELECT rank FROM project_order ORDER BY rank")
        .all().map((r) => r.rank),
      [0, 1, 2],
    );
    const expected = [
      {
        id: b,
        root: "/b-new",
        repo: "repo",
        directories: ["/b-new", "/b", "/child"],
      },
      { id: a, root: "/a", directories: ["/a"] },
      { id: c, root: "/c", directories: ["/c"] },
    ];
    assertEquals(order.list("u"), expected);
    db.close();
    db = new OtkDb(dir, [projectsMigrations], { busyms: 5000 });
    assertEquals(new ProjectOrderStore(db).list("u"), expected);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

test("project order migration stages saved positions by user", async () => {
  const dir = await fixture();
  let db = new OtkDb(dir, [{
    ...projectsMigrations,
    migrations: projectsMigrations.migrations.slice(0, 1),
  }], { busyms: 5000 });
  try {
    db.connection.exec(
      "INSERT INTO projects(user,directory,position,last_visit) VALUES ('u','/a',1,0),('u','/b',0,0),('other','/x',0,0)",
    );
    db.close();
    db = new OtkDb(dir, [projectsMigrations], { busyms: 5000 });
    const order = new ProjectOrderStore(db);
    assertEquals(order.legacy("u"), [{ directory: "/b", position: 0 }, {
      directory: "/a",
      position: 1,
    }]);
    order.dropLegacy("u");
    assertEquals(order.legacy("u"), []);
    assertEquals(order.legacy("other"), [{ directory: "/x", position: 0 }]);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
