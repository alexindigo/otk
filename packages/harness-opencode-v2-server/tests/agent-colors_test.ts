// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { AgentColors } from "../agent-colors.ts";
import type { AgentColor, CatalogAgent } from "@otk/protocol";

Deno.test("V2 optional agent decoration shares directory demand and keys by native agent identity", async () => {
  const pending = Promise.withResolvers<readonly CatalogAgent[]>();
  const ready: [string, Record<string, AgentColor>][] = [];
  let reads = 0;
  const colors = new AgentColors(
    () => {
      reads++;
      return pending.promise;
    },
    (id, value) => ready.push([id, value]),
    () => {
      throw new Error("Unexpected decoration failure");
    },
  );
  assertEquals(colors.peek("a", "/repo"), undefined);
  assertEquals(colors.peek("b", "/repo"), undefined);
  pending.resolve([{
    id: "build",
    name: "Builder display name",
    color: "#aabbcc",
    primary: true,
    mention: true,
  }]);
  await pending.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(reads, 1);
  assertEquals(ready, [["a", { build: "#aabbcc" }], ["b", {
    build: "#aabbcc",
  }]]);
  assertEquals(colors.peek("a", "/repo"), { build: "#aabbcc" });
  await colors.stop();
});
Deno.test("V2 released optional decoration cannot publish into a replacement lifetime", async () => {
  const pending = Promise.withResolvers<readonly CatalogAgent[]>(),
    published: unknown[] = [];
  const colors = new AgentColors(
    () => pending.promise,
    (...value) => published.push(value),
    () => {},
  );
  colors.peek("old", "/repo");
  colors.release("old");
  pending.resolve([{
    id: "build",
    name: "Build",
    primary: true,
    mention: true,
    color: "#aabbcc",
  }]);
  await colors.stop();
  assertEquals(published, []);
});
