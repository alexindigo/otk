// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertMatch } from "@std/assert";
import { randomID, requestFingerprint, sha256 } from "../mod.ts";

Deno.test("plain HTTP IDs remain RFC 4122 v4 without randomUUID", () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  try {
    const values = Array.from({ length: 1024 }, () => randomID());
    for (const value of values) {
      assertMatch(
        value,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    assertEquals(new Set(values).size, values.length);
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
});

Deno.test("plain HTTP SHA-256 matches native UTF-8 fingerprints at padding boundaries", async () => {
  const values = [
    "",
    "abc",
    "Plain HTTP - \u{1f642} \u00e9",
    ...[55, 56, 63, 64, 65, 127, 128, 1000].map((n) => "x".repeat(n)),
  ];
  const expected = await Promise.all(values.map(sha256));
  assertEquals(
    expected[0],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    expected[1],
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "subtle");
  Object.defineProperty(crypto, "subtle", {
    configurable: true,
    value: undefined,
  });
  try {
    assertEquals(await Promise.all(values.map(sha256)), expected);
    assertEquals(await Promise.all(values.map(requestFingerprint)), expected);
  } finally {
    if (descriptor) Object.defineProperty(crypto, "subtle", descriptor);
    else Reflect.deleteProperty(crypto, "subtle");
  }
});
