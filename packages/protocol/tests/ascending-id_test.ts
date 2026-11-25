// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertMatch } from "@std/assert";
import { ascendingID } from "../mod.ts";

// Characterized from opencode 2.2.6 schema/identifier.ts Identifier.create.
// Independent encoding catches timestamp scale, byte order and suffix drift.
function nativeID(timestamp: number, counter = 1): string {
  const value = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const time = Array.from(
    { length: 6 },
    (_, index) =>
      Number((value >> BigInt(40 - 8 * index)) & 0xffn)
        .toString(16).padStart(2, "0"),
  ).join("");
  return `msg_${time}0123456789ABCD`;
}

Deno.test("ascending IDs share native time encoding and interleave at nearby native clocks", () => {
  const now = Date.now, start = now();
  let timestamp = start;
  Date.now = () => timestamp;
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      timestamp = start + i * 3 + 1;
      const id = ascendingID("msg");
      assertMatch(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      assertEquals(id.slice(4, 16), nativeID(timestamp).slice(4, 16));
      ids.push(nativeID(timestamp - 1), id, nativeID(timestamp + 1));
    }
    assertEquals(ids.toSorted(), ids);
  } finally {
    Date.now = now;
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
});

Deno.test("ascending IDs keep creation order at one clock, counter overflow and clock rollback", () => {
  const now = Date.now;
  let timestamp = now() + 1000;
  Date.now = () => timestamp;
  try {
    const ids = Array.from({ length: 5000 }, () => ascendingID("prt"));
    timestamp--;
    ids.push(ascendingID("prt"));
    assertEquals(ids.toSorted(), ids);
    assertEquals(new Set(ids).size, ids.length);
    for (let i = 1; i < ids.length; i++) assert(ids[i] > ids[i - 1]);
    for (const id of ids) assertMatch(id, /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  } finally {
    Date.now = now;
  }
});
