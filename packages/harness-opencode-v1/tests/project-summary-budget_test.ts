// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { test } from "../../../tests/support/resources.ts";
import { waitFor } from "../../../tests/support/opencode.ts";
import { OpencodeV1Adapter } from "../adapter.ts";

test("@load @transport project activity reconciliation reads stay constant with 10 versus 130 discovered directories", async () => {
  const counts: number[] = [];
  for (const population of [10, 130]) {
    const root = await fixture(), settings = cfg();
    settings.harness.db = `${root}/unavailable.db`;
    const index = new SessionIndex();
    index.upsertMetadata({
      id: "opcv1-active",
      directory: "/active",
      projectID: "p",
      title: "active",
      timeCreated: 1,
      timeUpdated: 2,
      archived: false,
      status: "busy",
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    });
    const rows = [
      "active",
      ...Array.from({ length: population }, (_, i) => `discovered-${i}`),
    ].map((id) => ({
      id,
      directory: `/${id}`,
      projectID: "p",
      title: id,
      time: { created: 1, updated: 2 },
    }));
    let ready = false, reads = 0;
    const adapter = new OpencodeV1Adapter(
      settings,
      undefined,
      (input, options) => {
        const url = new URL(String(input));
        if (url.pathname === "/global/health") {
          return Promise.resolve(Response.json({ version: "1.18.34" }));
        }
        if (url.pathname === "/experimental/session") {
          return Promise.resolve(Response.json(rows));
        }
        if (
          ["/session/status", "/permission", "/question"].includes(url.pathname)
        ) {
          assertEquals(url.searchParams.get("directory"), "/active");
          reads++;
          return Promise.resolve(
            Response.json(
              url.pathname === "/session/status"
                ? { active: { type: "busy" } }
                : [],
            ),
          );
        }
        assertEquals(
          url.pathname,
          "/global/event",
          "Discovery performed a per-session API fallback",
        );
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                  ),
                );
                options?.signal?.addEventListener(
                  "abort",
                  () => controller.close(),
                  { once: true },
                );
              },
            }),
          ),
        );
      },
    );
    try {
      await adapter.core.start({
        index,
        connection: (s) => {
          ready ||= s === "connected";
        },
        indexReset: (rows) => index.resetMetadata(rows),
        indexUpsert: (e) => index.upsertMetadata(e),
        indexRemove: (id) => index.remove(id),
        content() {},
        bootstrapComplete() {},
        invalidate() {},
      });
      await waitFor(() => ready, Boolean);
      assertEquals(
        index.getMetadata("opcv1-active")?.activityAuthority,
        "current",
      );
      assertEquals(
        index.getMetadata("opcv1-discovered-0")?.activityAuthority,
        "unknown",
      );
      counts.push(reads);
    } finally {
      await adapter.core.stop();
      await Deno.remove(root, { recursive: true });
    }
  }
  assertEquals(counts, [3, 3]);
});
