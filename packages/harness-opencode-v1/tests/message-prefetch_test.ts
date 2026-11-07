// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  MessagePrefetchCache,
  messagePrefetchCodec,
  type PrefetchPage,
} from "../message-prefetch.ts";

Deno.test("@load @messages prefetch FIFO charges complete payloads, expires from insertion and rejects oversize", () => {
  let now = 0;
  const value: PrefetchPage = {
    page: { items: [] },
    metadata: { boundaries: [], prompt: { id: "unicode-\u00e9" } },
  };
  const probe = new MessagePrefetchCache({
    prefetchms: 10,
    prefetchbytes: 10000,
  }, () => now);
  probe.put("s", "a", value);
  const size = probe.bytes;
  const cache = new MessagePrefetchCache({
    prefetchms: 10,
    prefetchbytes: size * 2,
  }, () => now);
  cache.put("s", "a", value);
  now = 1;
  cache.put("t", "b", value);
  assertEquals(cache.bytes, size * 2);
  cache.get("a"); // Hits do not promote FIFO or renew insertion age.
  cache.put("u", "c", value);
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), value);
  assertEquals(cache.bytes <= size * 2, true);
  cache.put("s", "huge", { page: { items: [], next: "x".repeat(size * 3) } });
  assertEquals(cache.get("huge"), undefined);
  assertEquals(cache.bytes, size * 2);
  now = 11;
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.bytes, 0);
  cache.put("s", "a", value);
  cache.put("t", "b", value);
  cache.clear("s");
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), value);
  cache.clear();
  assertEquals(cache.bytes, 0);
});
Deno.test("native prefetch transport bounds fragments and roundtrips multibyte payload and metadata", () => {
  const value: PrefetchPage = {
    page: { items: [], next: "\u00e9".repeat(70000) },
    metadata: { boundaries: [] },
  };
  const builder = messagePrefetchCodec.create();
  for (const chunk of messagePrefetchCodec.chunks(value, 1)) {
    assertEquals(chunk.length <= 43692, true);
    builder.append(chunk);
  }
  assertEquals(builder.finish(), value);
});
