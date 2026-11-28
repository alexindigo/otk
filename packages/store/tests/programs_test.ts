// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { OtkDb, programsMigrations, ProgramStore } from "@otk/store";
import { test } from "../../../tests/support/resources.ts";
import { fixture } from "./support.ts";

test("programs persist dense ranks, choices and dismissed owners by user", async () => {
  const dir = await fixture();
  const open = () => new OtkDb(dir, [programsMigrations], { busyms: 5000 });
  let db = open();
  try {
    const store = new ProgramStore(db);
    assertEquals(store.auto("u"), false);
    const a = store.create("u", "  Work  ");
    const b = store.ensureAuto("u", "org");
    assertEquals(store.ensureAuto("u", "org"), b);
    const c = store.create("u", "Personal");
    store.move("u", c, { before: a });
    store.move("u", a, { after: b });
    store.rename("u", b, "  GitHub  ");
    for (const name of ["  ", "x".repeat(81), "a\0b"]) {
      assertThrows(() => store.rename("u", b, name), Error, "name");
    }
    assertThrows(() => store.move("u", b, { after: b }), Error, "itself");
    assertThrows(() => store.assign("other", "p", b), Error, "Unknown program");
    assertEquals(store.list("u").map((p) => [p.id, p.rank, p.name]), [
      [c, 0, "Personal"],
      [b, 1, "GitHub"],
      [a, 2, "Work"],
    ]);
    store.assign("u", "p", a);
    store.assign("u", "q", null);
    store.assign("u", "r", b);
    store.remove("u", a);
    store.dismiss("u", b);
    store.setAuto("u", true);
    assertEquals(store.ensureAuto("u", "org"), b);
    assertEquals(store.members("u"), new Map([["q", null]]));
    const saved = store.list("u");
    assertEquals(saved.map((p) => [p.id, p.rank, p.dismissed]), [
      [c, 0, false],
      [b, 1, true],
    ]);
    db.close();
    db = open();
    const reopened = new ProgramStore(db);
    assertEquals(reopened.list("u"), saved);
    assertEquals(reopened.members("u"), new Map([["q", null]]));
    assertEquals(reopened.auto("u"), true);
    assertEquals(reopened.auto("other"), false);
    assertEquals(reopened.list("other"), []);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

test("program store composes notifications and rolls back the whole write", async () => {
  const dir = await fixture();
  const db = new OtkDb(dir, [programsMigrations], { busyms: 5000 });
  try {
    const store = new ProgramStore(db);
    const changes: string[] = [];
    store.listen(({ user }) => changes.push(user));
    assertThrows(
      () =>
        db.write((tx) => {
          const id = store.create("u", "Rollback", tx);
          store.assign("u", "p", id, tx);
          throw new Error("abort");
        }),
      Error,
      "abort",
    );
    assertEquals(store.list("u"), []);
    assertEquals(changes, []);
    const id = db.write((tx) => {
      const id = store.create("u", "Together", tx);
      store.assign("u", "p", id, tx);
      store.setAuto("u", true, tx);
      assertEquals(changes, []);
      return id;
    });
    store.assign("u", "p", id);
    store.rename("u", id, "Together");
    store.setAuto("u", true);
    assertEquals(changes, ["u"]);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
