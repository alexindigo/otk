// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createIndex } from "@otk/client";
import { shellEntry } from "./shell-fixture.ts";

Deno.test("the canonical index publishes changed identities and structural readiness for accepted metadata", () => {
  const index = createIndex();
  const changes = Reflect.get(index, "changes");
  assert(
    typeof changes === "function",
    "The reduced index must expose its own change set",
  );
  const current = () => index.changes("server")!;
  index.receive("server", {
    t: "index.snapshot",
    rev: 0,
    entries: [shellEntry("a"), shellEntry("b")],
  });
  assertEquals(current(), {
    revision: 0,
    ids: ["a", "b"],
    structural: true,
    metadata: ["a", "b"],
  });
  index.receive("server", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "digest",
      id: "b",
      revision: 1,
      summary: { state: "ready", revision: 1 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    }],
  });
  assertEquals(current(), {
    revision: 1,
    ids: ["b"],
    structural: false,
    metadata: [],
  });
  index.receive("server", {
    t: "index.patch",
    rev: 2,
    ops: [{ op: "upsert", entry: { ...shellEntry("b"), title: "Renamed" } }],
  });
  assertEquals(current().structural, false);
  index.receive("server", {
    t: "index.patch",
    rev: 3,
    ops: [{ op: "upsert", entry: shellEntry("b", "/p", "a") }],
  });
  assertEquals(current(), {
    revision: 3,
    ids: ["b"],
    structural: true,
    metadata: ["b"],
  });
  const accepted = current();
  assertEquals(
    index.receive("server", { t: "index.patch", rev: 99, ops: [] }),
    false,
  );
  assertEquals(
    current(),
    accepted,
    "Rejected frames cannot install change authority",
  );
});
