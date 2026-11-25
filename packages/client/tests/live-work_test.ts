// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createLiveWork } from "../live-work.ts";

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
