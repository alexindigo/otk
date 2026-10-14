// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { CommandHub } from "@otk/client";
Deno.test("commands: invocation context, args, enabled state, metadata and owned unregister", async () => {
  let session = "one", calls = 0;
  const hub = new CommandHub(() => ({ session }), () => ["Mod+k"]);
  const release = hub.register({
    id: "external.run",
    title: "Run",
    category: "External",
    slash: ["run", "go"],
    enabled: (ctx) => ctx.session !== "blocked",
    run: (ctx, args: { delta: number }) => {
      calls += args.delta;
      return ctx.session;
    },
  });
  session = "two";
  assertEquals(await hub.run<string>("external.run", { delta: 3 }), "two");
  assertEquals(calls, 3);
  assertEquals(hub.resolveSlash("go"), "external.run");
  assertEquals(hub.list()[0].keys, ["Mod+k"]);
  session = "blocked";
  assertEquals(hub.list()[0].enabled, false);
  await assertRejects(
    () => hub.run("external.run", { delta: 5 }),
    Error,
    "unavailable",
  );
  assertEquals(calls, 3);
  assertThrows(() =>
    hub.register({
      id: "external.run",
      title: "Duplicate",
      category: "External",
      run: () => {},
    })
  );
  release();
  hub.register({
    id: "external.run",
    title: "Replacement",
    category: "External",
    run: () => 42,
  });
  release();
  assertEquals(await hub.run<number>("external.run"), 42);
  hub.unregister("external.run");
  await assertRejects(() => hub.run("external.run"), Error, "Unknown command");
});
Deno.test("commands: async errors propagate to invocation owner and registries stay independent", async () => {
  const one = new CommandHub(), two = new CommandHub();
  let changes = 0;
  const stop = one.subscribe(() => changes++);
  const release = one.register({
    id: "fail",
    title: "Fail",
    category: "External",
    hidden: true,
    run: () => Promise.reject(new Error("owner error")),
  });
  assertEquals(one.list(), []);
  assertEquals(two.has("fail"), false);
  await assertRejects(() => one.run("fail"), Error, "owner error");
  release();
  stop();
  assertEquals(changes, 2);
});
Deno.test("command metadata is immutable data independent of discovery and cannot bypass invocation ownership", async () => {
  const hub = new CommandHub();
  let predicates = 0, calls = 0;
  const aliases = ["private"];
  const release = hub.register({
    id: "external.private",
    title: "Private action",
    category: "External",
    hidden: true,
    slash: aliases,
    enabled: () => {
      predicates++;
      return true;
    },
    run: () => {
      calls++;
    },
  });
  aliases.push("caller-change");
  const metadata = hub.metadata("external.private")!;
  assertEquals(metadata.title, "Private action");
  assertEquals(metadata.slash, ["private"]);
  assertEquals(Object.isFrozen(metadata), true);
  assertEquals(Object.isFrozen(metadata.slash), true);
  assertThrows(() => (metadata.slash as string[]).push("bypass"), TypeError);
  assertEquals("run" in metadata, false);
  assertEquals("enabled" in metadata, false);
  assertEquals(hub.list(), []);
  assertEquals([predicates, calls], [0, 0]);
  await hub.run("external.private");
  assertEquals([predicates, calls], [1, 1]);
  release();
  assertEquals(hub.metadata("external.private"), undefined);
  await assertRejects(
    () => hub.run("external.private"),
    Error,
    "Unknown command",
  );
  hub.register({
    id: "external.public",
    title: "Public action",
    category: "External",
    run: () => {},
  });
  const listed = hub.list()[0].cmd;
  assertEquals(listed.title, "Public action");
  assertEquals("run" in listed, false);
  assertEquals("enabled" in listed, false);
  assertEquals(Object.isFrozen(listed), true);
});
