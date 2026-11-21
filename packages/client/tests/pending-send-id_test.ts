// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertMatch } from "@std/assert";
import { pendingMessageID } from "../pending-send.ts";
import type { ClientIntent } from "../requests.ts";

Deno.test("pending sends mint ascending native IDs even with the same request key and clock", () => {
  const now = Date.now;
  Date.now = () => 1795247000000;
  try {
    const intent = {
      key: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    } as ClientIntent;
    const first = pendingMessageID(intent), second = pendingMessageID(intent);
    assertMatch(first, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert(second > first);
  } finally {
    Date.now = now;
  }
});
