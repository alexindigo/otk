// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { pendingInventoryFixture } from "../support/pending-inventory.ts";
import { tempDir, test } from "../support/resources.ts";

test("history failure cannot veto native request retirement", async () => {
  const f = await pendingInventoryFixture(await tempDir("request-history-"));
  await f.start();
  const originalPut = f.adapter.transcript.requests.put.bind(
    f.adapter.transcript.requests,
  );
  f.adapter.transcript.requests.put = () =>
    Promise.reject(new Error("database or disk is full"));
  await assertRejects(
    async () =>
      await f.adapter.stream.ports.event(
        {
          type: "permission.replied",
          data: { sessionID: "ses_permission", requestID: "per_main" },
          location: { directory: f.directory },
        },
        f.adapter.stream.client,
        new AbortController().signal,
        1,
      ),
    Error,
    "disk is full",
  );
  assertEquals(f.adapter.pending.settled("permission", "per_main"), true);
  assertEquals(
    await f.adapter.pending.permissions.listPermissions("opcv2-ses_permission"),
    [],
  );
  assertEquals(
    f.index.getMetadata("opcv2-ses_permission")?.attention.errorState
      ?.observations.some((item) =>
        item.message.includes("save request history")
      ),
    true,
  );
  f.adapter.transcript.requests.put = originalPut;
  const page = await f.adapter.core.listMessages("opcv2-ses_permission", {});
  const retained = await f.adapter.transcript.requests.get(
    "opcv2-ses_permission",
    "per_main",
  );
  assertEquals(!!retained?.outcome, true);
  assertEquals(
    page.items.some((message) => message.id === retained?.outcome?.id),
    true,
  );
  assertEquals(
    f.index.getMetadata("opcv2-ses_permission")?.attention.errorState
      ?.observations.some((item) =>
        item.message.includes("save request history")
      ),
    false,
  );
});
