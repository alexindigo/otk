// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { canonicalRequest, requestRef } from "../mod.ts";

Deno.test("request fingerprints use canonical JSON and validate intent identities", () => {
  assertEquals(
    canonicalRequest({ z: [2, 1], a: { c: true, b: null } }),
    '{"a":{"b":null,"c":true},"z":[2,1]}',
  );
  for (
    const value of [NaN, undefined, { x: undefined }, new Date(), {
      n: Infinity,
    }]
  ) {
    assertThrows(() => canonicalRequest(value), TypeError);
  }
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: crypto.randomUUID(),
  };
  assertEquals(requestRef(ref), ref);
  assertThrows(() => requestRef({ ...ref, key: "bad" }), TypeError);
});
