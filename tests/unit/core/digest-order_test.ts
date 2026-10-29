// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestPublicationOrder } from "../../../core/digest/publication-order.ts";
import { test } from "../../support/resources.ts";

test("publication chunks retain one identity order while other identities continue", async () => {
  const order = new DigestPublicationOrder((readiness) => readiness);
  const held = Promise.withResolvers<void>(), seen: string[] = [];
  const signal = new AbortController().signal;
  const first = order.reserve("same").run(signal, async () => {
    seen.push("old-0");
    await held.promise;
    seen.push("old-1");
  });
  const next = order.reserve("same").run(signal, () => {
    seen.push("new");
    return Promise.resolve();
  });
  await order.reserve("other").run(signal, () => {
    seen.push("independent");
    return Promise.resolve();
  });
  assertEquals(seen, ["old-0", "independent"]);
  held.resolve();
  await Promise.all([first, next]);
  assertEquals(seen, ["old-0", "independent", "old-1", "new"]);
});

test("retiring a reserved publisher cannot let its successor overtake an earlier producer", async () => {
  const order = new DigestPublicationOrder((readiness) => readiness),
    held = Promise.withResolvers<void>();
  const signal = new AbortController().signal, seen: string[] = [];
  const first = order.reserve("same").run(signal, async () => {
    await held.promise;
    seen.push("first");
  });
  const cancelled = order.reserve("same");
  const third = order.reserve("same").run(signal, () => {
    seen.push("third");
    return Promise.resolve();
  });
  cancelled.release();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(seen, []);
  held.resolve();
  await Promise.all([first, third]);
  assertEquals(seen, ["first", "third"]);
});
