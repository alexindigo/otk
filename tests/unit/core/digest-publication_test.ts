// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createIndex } from "@otk/client";
import type { IndexOp, ServerFrame } from "@otk/protocol";
import { IndexStore } from "../../../core/index/store.ts";
import { IndexView } from "../../../core/index/view.ts";
import { test } from "../../support/resources.ts";

test("index applied credit coalesces a held identity and bounds acquisition chunks", () => {
  const server = new IndexStore(), client = createIndex();
  const rows = Array.from({ length: 300 }, (_, n) => `tstv1-row-${n}`);
  const metadata = {
    id: rows[0],
    directory: "/p",
    projectID: "p",
    title: "Before",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  for (const id of rows) server.upsertMetadata({ ...metadata, id });
  server.flush();
  let scope = {
    epoch: 0,
    directory: "/p",
    crumbs: [] as string[],
    rows: [] as string[],
  };
  const frames: ServerFrame[] = [];
  const view = new IndexView(
    server,
    () => scope,
    () => [],
    (f) => frames.push(f),
  );
  const apply = (frame: ServerFrame) => {
    if (frame.t !== "index.snapshot" && frame.t !== "index.patch") {
      throw new Error("Not index");
    }
    assertEquals(client.receive("one", frame), true);
    view.applied(frame.epoch!, frame.rev);
  };
  try {
    view.snapshot();
    apply(frames[0]);
    scope = { epoch: 1, directory: "/p", crumbs: [], rows };
    view.refresh();
    const first = frames[1];
    assertEquals(first.t === "index.patch" && first.ops.length, 128);
    for (let n = 0; n < 100; n++) {
      server.upsertMetadata({ ...metadata, title: `Update ${n}` });
      server.flush();
      view.refresh();
    }
    assertEquals(frames.length, 2, "No new frame while applied credit is held");
    view.applied(0, 999);
    assertEquals(
      frames.length,
      2,
      "Wrong epoch/revision cannot release credit",
    );
    for (let n = 1; n < frames.length; n++) {
      const frame = frames[n];
      assertEquals(frame.t === "index.patch" && frame.ops.length <= 128, true);
      apply(frame);
    }
    assertEquals(client.ids("one").length, 300);
    assertEquals(client.get("one", metadata.id)?.title, "Update 99");
    assertEquals(frames.length, 4);
  } finally {
    view.close();
  }
});

test("a scoped batch preserves metadata and every selected turn when coalescing one identity", async () => {
  const server = new IndexStore(), client = createIndex();
  const metadata = {
    id: "tstv1-one",
    directory: "/p",
    projectID: "p",
    title: "Before",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  server.upsertMetadata(metadata);
  server.flush();
  const view = new IndexView(
    server,
    () => ({ epoch: 1, selected: metadata.id, crumbs: [], rows: [] }),
    () => [],
    (frame) => {
      if (
        frame.t === "index.snapshot" || frame.t === "index.patch"
      ) {
        assertEquals(client.receive("one", frame), true);
        view.applied(frame.epoch!, frame.rev);
      }
    },
  );
  view.snapshot();
  const stop = server.listen((frame) => view.refresh(frame));
  const total = {
    calls: 1,
    cost: 0,
    contextPeak: 1,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  try {
    server.upsertMetadata({ ...metadata, title: "After" });
    for (const [n, key] of ["a", "b"].entries()) {
      server.applyDigest({
        id: metadata.id,
        revision: n + 1,
        summary: { revision: n + 1, state: "ready" },
        turns: { upsert: { [key]: total }, remove: [] },
        deleted: null,
      });
    }
    await Promise.resolve();
    assertEquals(client.get("one", metadata.id)?.title, "After");
    assertEquals(Object.keys(client.get("one", metadata.id)!.digest.turns), [
      "a",
      "b",
    ]);
    server.applyDigest({
      id: metadata.id,
      revision: 3,
      summary: { revision: 3, state: "ready" },
      turns: { upsert: { c: total }, remove: [] },
      deleted: null,
    });
    server.applyDigest({
      id: metadata.id,
      revision: 4,
      summary: { revision: 4, state: "ready" },
      turns: { upsert: {}, remove: ["a"] },
      deleted: null,
    });
    await Promise.resolve();
    assertEquals(Object.keys(client.get("one", metadata.id)!.digest.turns), [
      "b",
      "c",
    ]);
  } finally {
    stop();
  }
});

test("field-owned digest parts preserve live fields and every wire revision reaches the client", async () => {
  const server = new IndexStore(), client = createIndex();
  const frames: ServerFrame[] = [];
  server.listen((frame) => {
    frames.push(frame);
    if (frame.t === "index.snapshot" || frame.t === "index.patch") {
      assertEquals(client.receive("server", frame), true);
    }
  });
  server.reset([{
    id: "tstv1-one",
    directory: "/p",
    projectID: "p",
    title: "Live title",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "busy",
    attention: {
      permissions: 1,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  }]);
  const revision = server.rev;
  for (const state of ["digesting", "ready"] as const) {
    server.applyDigest({
      id: "tstv1-one",
      revision: 1,
      summary: { revision: 1, state, messageCount: 10 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    });
  }
  assertEquals(
    server.applyDigest({
      id: "tstv1-one",
      revision: 0,
      summary: { revision: 0, state: "digesting" },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    }),
    false,
  );
  await Promise.resolve();
  assertEquals(server.rev, revision + 2);
  const operations = frames.flatMap((frame) =>
    frame.t === "index.patch" ? frame.ops : []
  ) as IndexOp[];
  assertEquals(operations.map((op) => op.op), ["digest", "digest"]);
  assertEquals(client.state.entries["server/tstv1-one"].digest.state, "ready");
  assertEquals(client.state.entries["server/tstv1-one"].status, "busy");
  assertEquals(
    client.state.entries["server/tstv1-one"].attention.permissions,
    1,
  );
});
