// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import { test } from "../../../tests/support/resources.ts";

test("metadata and digest writes share identity without replacing live attention", () => {
  const index = new SessionIndex();
  const metadata = {
    id: "tstv1-one",
    directory: "/p",
    projectID: "p",
    title: "One",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  index.upsertMetadata(metadata);
  const enriched = {
    ...metadata,
    digest: { state: "ready" as const, revision: 99, turns: {} },
    deleted: { at: 1, how: "provider" as const },
  };
  index.upsertMetadata(enriched);
  assertEquals(index.get(metadata.id)?.deleted, undefined);
  assertEquals(index.get(metadata.id)?.digest, {
    state: "digesting",
    revision: 0,
    turns: {},
  });
  index.applyDigest({
    id: metadata.id,
    revision: 1,
    summary: { state: "ready", revision: 1, messageCount: 0 },
    turns: { upsert: {}, remove: [] },
    deleted: null,
  });
  index.upsertMetadata({
    ...metadata,
    status: "busy",
    title: "Live",
    attention: { ...metadata.attention, permissions: 1 },
  });
  index.applyDigest({
    id: metadata.id,
    revision: 2,
    summary: { state: "ready", revision: 2, messageCount: 1 },
    turns: { upsert: {}, remove: [] },
    deleted: null,
  });
  assertEquals(index.get(metadata.id)?.title, "Live");
  assertEquals(index.get(metadata.id)?.status, "busy");
  assertEquals(index.get(metadata.id)?.attention.permissions, 1);
  assertEquals(index.get(metadata.id)?.digest.messageCount, 1);
  index.applyDigest({
    id: metadata.id,
    revision: 1,
    summary: { state: "ready", revision: 1, messageCount: 0 },
    turns: { upsert: {}, remove: [] },
    deleted: null,
  });
  assertEquals(index.get(metadata.id)?.digest.messageCount, 1);
  index.resetMetadata([]);
  assertEquals(index.get(metadata.id)?.title, "Live");
});
