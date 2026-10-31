// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type DigestPort, SessionIndex } from "@otk/harness";
import type { SessionMetadata } from "@otk/protocol";
import { OpencodeV1Adapter } from "../adapter.ts";
import { cfg } from "../../../tests/support/config.ts";
import { bounded, tempDir, test } from "../../../tests/support/resources.ts";

test("selected digest bootstrap prepares attention and publishes metadata within its injected row budget", async () => {
  const root = await tempDir("metadata-budget-");
  const settings = cfg();
  settings.harness.db = root + "/absent.db";
  const index = new SessionIndex();
  let tick = 0, preparing = false, historyReads = 0;
  const prepared = new Map<number, Set<string>>();
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = (value, options) => {
    if (preparing && value && typeof value === "object" && "digest" in value) {
      historyReads++;
    }
    return clone(value, options);
  };
  const entries: SessionMetadata[] = Array.from({ length: 8 }, (_, n) => ({
    id: `opcv1-ses_${n}`,
    ...(n ? { parentID: `opcv1-ses_${n - 1}` } : {}),
    title: `Row ${n}`,
    directory: "/p",
    projectID: "p",
    archived: false,
    timeCreated: 1,
    timeUpdated: 2,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  }));
  for (const entry of entries) {
    const attention = entry.attention;
    Object.defineProperty(entry, "attention", {
      enumerable: true,
      get() {
        const ids = prepared.get(tick) ?? new Set<string>();
        if (preparing) {
          ids.add(entry.id);
          prepared.set(tick, ids);
        }
        return attention;
      },
    });
  }
  const digest = {
    publishrows: 2,
    start: () => Promise.resolve(),
    catalog: () => {
      for (const entry of entries) index.upsertMetadata(entry);
      preparing = true;
      return Promise.resolve({ entries, authoritative: true, hints: ["/p"] });
    },
    observe() {},
    deleted: () => Promise.resolve(),
    detail: () => Promise.reject(new Error("Not requested")),
    transcriptMetadata: () => Promise.reject(new Error("Not requested")),
    read: ((kind: string) => {
      assertEquals(kind, "catalog.questions");
      return Promise.resolve([{
        id: "q",
        sessionID: "opcv1-ses_7",
        questions: [],
      }]);
    }) as DigestPort["read"],
    deleteIntent: () => Promise.resolve(),
    scope() {},
    release() {},
    stop: () => Promise.resolve(),
  };
  const adapter = new OpencodeV1Adapter(settings, undefined, (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1" }));
    }
    if (path === "/session/status") return Promise.resolve(Response.json({}));
    if (path === "/permission") return Promise.resolve(Response.json([]));
    if (path === "/question") {
      return Promise.resolve(
        Response.json([{ id: "q", sessionID: "ses_7", questions: [] }]),
      );
    }
    assertEquals(path, "/global/event");
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${
                  JSON.stringify({
                    payload: { type: "server.connected", properties: {} },
                  })
                }\n\n`,
              ),
            );
          },
        }),
      ),
    );
  }, digest);
  const rows = new Map<number, number>(), ready = Promise.withResolvers<void>();
  const pulse = setInterval(() => tick++, 0);
  const record = (count: number) =>
    rows.set(tick, (rows.get(tick) ?? 0) + count);
  try {
    await adapter.core.start({
      index,
      connection() {},
      indexReset: (entries) => {
        record(entries.length);
        index.resetMetadata(entries);
      },
      indexUpsert: (entry) => {
        preparing = false;
        record(1);
        index.upsertMetadata(entry);
      },
      indexRemove() {},
      content() {},
      bootstrapComplete: () => ready.resolve(),
      invalidate() {},
    });
    await bounded("budgeted native metadata bootstrap", ready.promise);
    assertEquals([...index.values()].length, 8);
    for (let n = 0; n < 8; n++) {
      const attention = index.get(`opcv1-ses_${n}`)!.attention;
      assertEquals(attention.questions, n === 7 ? 1 : 0);
      assertEquals(attention.childQuestions, n === 7 ? 0 : 1);
    }
    assertEquals(
      {
        withinBudget: Math.max(...[...prepared.values()].map((ids) =>
          ids.size
        )) <= 2,
        historyReads,
      },
      { withinBudget: true, historyReads: 0 },
      "Catalog preparation must yield within its row budget without copying turn history",
    );
    assertEquals([...rows.values()].reduce((a, b) => a + b, 0), 8);
    assertEquals(
      Math.max(...rows.values()) <= 2,
      true,
      JSON.stringify([...rows]),
    );
  } finally {
    preparing = false;
    globalThis.structuredClone = clone;
    clearInterval(pulse);
    await adapter.core.stop();
  }
});
