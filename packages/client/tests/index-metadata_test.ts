// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { createIndex } from "../index.ts";
import { shellEntry } from "./shell-fixture.ts";

Deno.test("metadata and membership projections stay stable through digest-only changes, but follow activity and deletion", () => {
  const index = createIndex();
  const a = shellEntry("a"), b = shellEntry("b");
  index.receive("server", { t: "index.snapshot", rev: 1, entries: [a, b] });
  const identities = index.ids("server"), catalog = index.catalog("server");
  assertEquals("digest" in catalog[0], false);
  index.receive("server", {
    t: "index.patch",
    rev: 2,
    ops: [{
      op: "digest",
      id: "a",
      revision: 2,
      summary: { state: "ready", revision: 2 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    }],
  });
  assertStrictEquals(index.ids("server"), identities);
  assertStrictEquals(index.catalog("server"), catalog);
  assertEquals(index.changes("server")?.metadata, []);
  assertEquals(index.get("server", "a")?.digest.state, "ready");
  index.receive("server", {
    t: "index.patch",
    rev: 3,
    ops: [{
      op: "upsert",
      entry: { ...index.get("server", "a")!, status: "busy" },
    }],
  });
  assertStrictEquals(index.ids("server"), identities);
  assertNotStrictEquals(index.catalog("server"), catalog);
  assertEquals(index.catalog("server")[0].status, "busy");
  assertEquals(index.changes("server")?.metadata, ["a"]);
  const busy = index.catalog("server");
  index.receive("server", {
    t: "index.patch",
    rev: 4,
    ops: [{
      op: "digest",
      id: "a",
      revision: 3,
      summary: { state: "ready", revision: 3 },
      turns: { upsert: {}, remove: [] },
      deleted: { at: 9, how: "provider" },
    }],
  });
  assertNotStrictEquals(index.catalog("server"), busy);
  assertEquals(index.catalog("server")[0].deleted?.how, "provider");
  assertEquals(index.changes("server")?.metadata, ["a"]);
});
