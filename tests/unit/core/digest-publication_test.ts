// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createIndex } from "@otk/client";
import type { IndexOp, ServerFrame } from "@otk/protocol";
import { IndexStore } from "../../../core/index/store.ts";
import { test } from "../../support/resources.ts";

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
