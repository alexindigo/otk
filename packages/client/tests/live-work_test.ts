// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createLiveWork, helperCountsLabel } from "../live-work.ts";

Deno.test("live-work stop capability and admission survive presentation replacement", async () => {
  let finish!: () => void, calls = 0;
  const item = {
    id: "helper/h",
    sessionID: "h",
    kind: "helper" as const,
    label: "Helper",
    title: "Work",
  };
  const shell = { ...item, id: "shell/s", kind: "shell" as const };
  const owner = createLiveWork({
    items: () => [item, shell],
    stopHelper: () => async (id) => {
      assertEquals(id, "h");
      calls++;
      await new Promise<void>((resolve) => finish = resolve);
    },
  });
  assertEquals(owner.canStop(shell.id), false);
  assertEquals(owner.canStop(item.id), true);
  const first = owner.stop(item.id), second = owner.stop(item.id);
  assertEquals(first, second);
  await Promise.resolve();
  assertEquals(calls, 1);
  assertEquals(owner.stopping(item.id), true);
  finish();
  await first;
  assertEquals(owner.stopping(item.id), false);
});

Deno.test("live-work helper counts omit zero and agree with their verbs", () => {
  assertEquals(
    helperCountsLabel({ running: 4, needsYou: 3, notReturned: 221 }),
    "4 running · 3 need you · 221 not returned",
  );
  const blocked = { running: 0, needsYou: 1, notReturned: 2 };
  assertEquals(helperCountsLabel(blocked), "1 needs you · 2 not returned");
  assertEquals(
    helperCountsLabel(blocked, "spoken"),
    "1 needs you, 2 not returned",
  );
  assertEquals(
    helperCountsLabel({ running: 0, needsYou: 0, notReturned: 0 }),
    "",
  );
});
