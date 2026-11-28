// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { entityKey } from "@otk/protocol";
import {
  OtkDb,
  programsMigrations,
  ProgramStore,
  ProjectOrderStore,
  projectsMigrations,
} from "@otk/store";
import { ProjectPrograms } from "../../../core/features/programs.ts";
import { EntityStates } from "../../../core/index/entity-states.ts";
import { SessionSupervision } from "../../../core/index/supervision.ts";
import { fixture } from "../../support/config.ts";
import { test } from "../../support/resources.ts";

async function setup() {
  const path = await fixture();
  const db = new OtkDb(path, [projectsMigrations, programsMigrations], {
    busyms: 5000,
  });
  const order = new ProjectOrderStore(db);
  const store = new ProgramStore(db);
  const owners = new Map([["/a", "zeta"], ["/b", "alpha"], ["/c", "zeta"]]);
  const programs = new ProjectPrograms(store, order, {
    owner: (dir) => owners.get(dir),
  });
  const a = order.create("u", "/a");
  const b = order.create("u", "/b");
  const c = order.create("u", "/c");
  return {
    db,
    order,
    store,
    programs,
    owners,
    a,
    b,
    c,
    close() {
      programs.close();
      db.close();
    },
  };
}

test("programs honor explicit choices and stable automatic admission", async () => {
  const { programs, order, owners, a, b, c, close } = await setup();
  try {
    const frame = () => programs.frame("u");
    const manual = programs.create("u", { name: "Manual" });
    programs.assign("u", { project: a, program: null });
    programs.assign("u", { project: b, program: manual });
    programs.setAuto("u", true);
    const zeta = frame().programs[1].id;
    assertEquals(frame().programs.map((p) => p.name), ["Manual", "zeta"]);
    assertEquals(frame().members, {
      [a]: { program: null, by: "user" },
      [b]: { program: manual, by: "user" },
      [c]: { program: zeta, by: "auto" },
    });
    programs.unassign("u", a);
    programs.unassign("u", b);
    assertEquals(frame().members[a], { program: zeta, by: "auto" });
    assertEquals(frame().programs.map((p) => p.name), [
      "Manual",
      "zeta",
      "alpha",
    ]);
    const alpha = frame().programs[2].id;
    programs.rename("u", zeta, "  Team  ");
    programs.move("u", alpha, { before: manual });
    programs.assign("u", { project: c, program: zeta });
    programs.setAuto("u", false);
    assertEquals(frame().programs.map((p) => p.name), ["Manual", "Team"]);
    programs.setAuto("u", true);
    assertEquals(frame().programs.map((p) => p.name), [
      "alpha",
      "Manual",
      "Team",
    ]);
    assertEquals(frame().programs[2], {
      id: zeta,
      name: "Team",
      named: true,
      origin: "auto",
      owner: "zeta",
    });
    programs.assign("u", { project: b, program: zeta });
    programs.delete("u", zeta);
    assertEquals([a, b, c].map((id) => frame().members[id]?.program ?? null), [
      null,
      null,
      null,
    ]);
    programs.setAuto("u", false);
    programs.setAuto("u", true);
    const d = order.create("u", "/d");
    owners.set("/d", "zeta");
    programs.identityChanged("u");
    assertEquals(frame().members[d]?.program ?? null, null);
    assertEquals(frame().programs.map((p) => p.name), ["Manual"]);
    owners.set("/d", "new-owner");
    programs.identityChanged("u");
    assertEquals(frame().programs.map((p) => p.name), ["Manual", "new-owner"]);
    assertEquals(programs.frame("other").programs, []);
  } finally {
    close();
  }
});

test("assignment and move commit together; merge forgets only the retired ID", async () => {
  const { programs, order, store, db, a, b, c, close } = await setup();
  try {
    const first = programs.create("u", { name: "First", projects: [a, b] });
    const second = programs.create("u", { name: "Second", projects: [c] });
    assertThrows(() =>
      programs.assign("u", { project: b, program: second, before: "missing" })
    );
    assertEquals(store.members("u").get(b), first);
    assertEquals(order.list("u").map((p) => p.id), [a, b, c]);
    const observed: string[] = [];
    const stopOrder = order.listen(({ user }) => {
      assertEquals(store.members(user).get(b), second);
      observed.push("order");
    });
    const stop = programs.listen(() => {
      assertEquals(order.list("u").map((p) => p.id), [a, c, b]);
      observed.push("programs");
    });
    db.write((tx) => {
      programs.assign("u", { project: b, program: second, after: c }, tx);
      assertEquals(observed, []);
    });
    assertEquals(observed.toSorted(), ["order", "programs"]);
    stop();
    stopOrder();
    order.attach("u", "/b", a);
    assertEquals(store.members("u"), new Map([[a, first], [c, second]]));
    assertEquals(programs.frame("u").members[b], undefined);
    programs.delete("u", first);
    assertEquals(programs.frame("u").members[a]?.program ?? null, null);
  } finally {
    close();
  }
});

test("program and Other entities follow D78 project evidence through moves", () => {
  const states = new EntityStates(new SessionSupervision(), {
    getMetadata: () => undefined,
    ancestors: () => [],
    descendants: () => new Set(),
  }, () => {});
  try {
    states.project("/red", ["/red/child"]);
    states.project("/yellow", []);
    states.project("/green", []);
    states.checkout("/red/child", 1);
    states.checkoutOperation("/green", "working");
    const id = "tstv1-yellow";
    states.member(id, "/yellow");
    states.session(
      {
        id,
        directory: "/yellow",
        projectID: "yellow",
        title: "yellow",
        status: "idle",
        timeCreated: 1,
        timeUpdated: 2,
        archived: false,
        attention: {
          permissions: 0,
          questions: 0,
          childPermissions: 0,
          childQuestions: 0,
        },
        activity: { terminal: 2 },
      },
      0,
      2,
    );
    const status = (id: string) => states.get(entityKey("program", id))?.state;
    states.programs(
      new Map([["main", ["/red", "/yellow", "/green"]], ["none", []]]),
    );
    assertEquals(status("main"), "blocked");
    states.programs(
      new Map([["main", ["/yellow", "/green"]], ["none", ["/red"]]]),
    );
    assertEquals([status("main"), status("none")], ["finished", "blocked"]);
    states.programs(
      new Map([["main", ["/green"]], ["none", ["/red", "/yellow"]]]),
    );
    assertEquals(status("main"), "working");
    states.checkout("/red/child", 0);
    assertEquals(status("none"), "finished");
    states.checkoutOperation("/green");
    assertEquals(status("main"), "none");
    states.programs(new Map());
    assert(!states.get(entityKey("program", "main")));
  } finally {
    states.close();
  }
});
