// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionErrors } from "../errors.ts";
import { Opencode1Adapter } from "../adapter.ts";
import { resources, test } from "../../../tests/support/resources.ts";
import { cfg } from "../../../tests/support/config.ts";
import type { SessionErrorState } from "@otk/protocol";
Deno.test("empty error observations are not retained across busy traffic and repeated resets", () => {
  const published: string[] = [];
  const owner = new SessionErrors((id) => published.push(id));
  for (let n = 0; n < 1000; n++) {
    owner.register(String(n));
    owner.clear(String(n));
  }
  published.length = 0;
  owner.reset();
  assertEquals(published, [], "Reset revisited every empty busy observation");
  owner.native("active", { message: "Failed" });
  owner.reset();
  assertEquals(published, ["active", "active"]);
  published.length = 0;
  owner.reset();
  assertEquals(published, [], "Reset retained already-cleared observations");
});
Deno.test("empty consumer clocks release and fresh generations retire deletion fences without reviving old HTTP tokens", () => {
  let retained = true;
  const published: SessionErrorState[] = [];
  const owner = new SessionErrors(
    (_id, state) => published.push(state),
    () => retained,
  );
  owner.native("outside", { message: "Failure" });
  owner.clear("outside");
  assertEquals(owner.snapshot("outside"), published.at(-1));
  retained = false;
  owner.release("outside");
  const before = published.length;
  owner.reset();
  assertEquals(published.length, before, "Released empty state survived reset");
  const old = owner.begin("deleted", "command");
  owner.remove("deleted");
  owner.native("deleted", { message: "Old native failure" });
  assertEquals(owner.snapshot("deleted").observations, []);
  owner.reconcile(new Set());
  owner.http(old, { message: "Old HTTP failure" });
  assertEquals(owner.snapshot("deleted").observations, []);
  owner.native("deleted", { message: "Fresh generation observation" });
  assertEquals(
    owner.snapshot("deleted").observations[0].message,
    "Fresh generation observation",
  );
});
test("native errors outside the index window remain queryable and subscribed clearing stays coherent", async () => {
  const root = await resources().tempDir("errors-"), settings = cfg();
  settings.harness.db = root + "/missing.db";
  const ready = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>, marker = 0;
  let barrier = Promise.withResolvers<void>(),
    last: SessionErrorState | undefined;
  const session = (id: string) => ({
    id,
    directory: "/project",
    projectID: "p",
    title: id,
    time: { created: 1, updated: 2 },
  });
  const send = (type: string, properties: object) =>
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ payload: { type, properties } })}\n\n`,
      ),
    );
  const adapter = new Opencode1Adapter(settings, undefined, (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1" }));
    }
    if (path === "/experimental/session") {
      return Promise.resolve(Response.json([session("root")]));
    }
    if (path === "/session/outside") {
      return Promise.resolve(Response.json(session("outside")));
    }
    if (path === "/session/status") return Promise.resolve(Response.json({}));
    if (path === "/permission" || path === "/question") {
      return Promise.resolve(Response.json([]));
    }
    assertEquals(path, "/global/event");
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
            send("server.connected", {});
          },
        }),
      ),
    );
  });
  const drain = async () => {
    barrier = Promise.withResolvers<void>();
    send("session.status", {
      sessionID: "root",
      status: { type: "retry", attempt: ++marker, message: "Barrier", next: 1 },
    });
    await barrier.promise;
  };
  try {
    await adapter.core.start({
      connection() {},
      indexReset() {},
      indexUpsert(entry) {
        if (entry.id === "root" && entry.retry?.attempt === marker) {
          barrier.resolve();
        }
      },
      indexRemove() {},
      content(id, event) {
        if (id === "outside" && event.op === "session.error") {
          last = event.errorState;
        }
      },
      resync: () => ready.resolve(),
    });
    await ready.promise;
    send("session.error", {
      sessionID: "outside",
      error: {
        name: "UnknownError",
        data: { message: "Outside-window failure" },
      },
    });
    await drain();
    assertEquals(
      (await adapter.core.getSession("outside")).error,
      "Outside-window failure",
      "An index window became an error admission filter",
    );
    adapter.core.subscriptions("outside", 1);
    send("session.status", { sessionID: "outside", status: { type: "busy" } });
    await drain();
    assertEquals((await adapter.core.getSession("outside")).errorState, last);
    adapter.core.subscriptions("outside", 0);
    assertEquals((await adapter.core.getSession("outside")).error, undefined);
  } finally {
    await adapter.core.stop();
  }
});
