// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import type { V2Event } from "../stream.ts";
import { cfg } from "../../../tests/support/config.ts";
import { bounded, tempDir, test } from "../../../tests/support/resources.ts";

async function fixture() {
  const root = await tempDir("dispatch-lag-"), settings = cfg();
  const index = new SessionIndex(), calls: string[] = [], events: string[] = [];
  const permissionPublications: { id: string; ancestors: string[] }[] = [];
  const native = {
    id: "ses_dispatch",
    title: "Initial",
    projectID: "project",
    location: { directory: "/repo" },
    time: { created: 1, updated: 1 },
  };
  let hold: Promise<void> | undefined;
  let inventoryHold: Promise<void> | undefined;
  const locations: { directory: string }[] = [];
  let publications = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === "/api/info") {
        return Response.json({ version: "2.2.6", pid: 42 });
      }
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (path === "/api/debug/location") return Response.json(locations);
      if (path === "/api/permission/request") {
        await inventoryHold;
        return Response.json({ data: [] });
      }
      if (path === "/api/form" || path === "/api/shell") {
        return Response.json({ data: [] });
      }
      if (path === "/api/session/ses_dispatch") {
        await hold;
        return Response.json({ data: native });
      }
      if (path === "/api/session/ses_dispatch/message") {
        return Response.json({ data: [], cursor: {} });
      }
      if (path === "/api/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              value.enqueue(new TextEncoder().encode(
                'data: {"type":"server.connected","data":{}}\n\n',
              ));
              request.signal.addEventListener("abort", () => {
                try {
                  value.close();
                } catch { /* already retired */ }
              }, { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 404 });
    },
  );
  const serviceFile = root + "/service.json";
  await Deno.writeTextFile(
    serviceFile,
    JSON.stringify({
      url: `http://127.0.0.1:${server.addr.port}`,
      version: "2.2.6",
      pid: 42,
    }),
  );
  const diagnostics: unknown[] = [];
  const adapter = new OpencodeV2ServerAdapter(
    { serviceFile, harness: settings.harness, messages: settings.messages },
    undefined,
    (error) => diagnostics.push(error),
  );
  const original = adapter.transcript.event.bind(adapter.transcript);
  adapter.transcript.event = async (event) => {
    events.push(event.type);
    await original(event);
  };
  await adapter.core.start({
    index,
    connection() {},
    indexReset() {},
    indexRemove: (id) => index.remove(id),
    content(id, op) {
      if (op.op === "permission.upsert") {
        permissionPublications.push({ id, ancestors: index.ancestors(id) });
      }
    },
    invalidate() {},
    bootstrapComplete() {},
    indexUpsert: (entry) => {
      publications++;
      index.upsertMetadata(entry);
    },
  });
  index.upsertMetadata({
    id: "opcv2-ses_dispatch",
    title: "Initial",
    projectID: "project",
    directory: "/repo",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  calls.length = 0;
  const send = (event: V2Event) =>
    controller.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify(event)}\n\n`,
    ));
  return {
    adapter,
    locations,
    get publications() {
      return publications;
    },
    index,
    calls,
    events,
    permissionPublications,
    native,
    diagnostics,
    send,
    hold(value: Promise<void> | undefined) {
      hold = value;
    },
    holdInventory(value: Promise<void> | undefined) {
      inventoryHold = value;
    },
    async close() {
      await adapter.core.stop();
      await server.shutdown();
    },
  };
}
async function until(check: () => boolean) {
  const end = performance.now() + 5000;
  while (!check()) {
    if (performance.now() > end) {
      throw new Error("Dispatch observation timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("V2 permission burst is incremental and does not put inventories or history before transcript delivery", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 60; i++) {
      f.send({
        type: "permission.asked",
        data: {
          sessionID: "ses_dispatch",
          id: `per_${i}`,
          action: "read",
          resources: ["README.md"],
        },
      });
      f.send({
        type: "permission.replied",
        created: 10 + i,
        data: {
          sessionID: "ses_dispatch",
          requestID: `per_${i}`,
          reply: "once",
        },
      });
    }
    f.send({
      type: "session.message.content.updated",
      data: {
        sessionID: "ses_dispatch",
        messageID: "msg_marker",
      },
    });
    await bounded(
      "transcript marker after permission burst",
      until(() => f.events.includes("session.message.content.updated")),
    );
    assertEquals(
      f.calls,
      [],
      "No native inventory, family, or body read per permission event",
    );
    assertEquals(
      f.events.filter((type) => type === "permission.replied").length,
      60,
    );
    assertEquals(
      f.index.getMetadata("opcv2-ses_dispatch")?.attention.permissions,
      0,
    );
    assertEquals(
      (await f.adapter.capabilities.permissions!.listPermissions(
        "opcv2-ses_dispatch",
      )).length,
      0,
    );
    assertEquals(
      (await f.adapter.transcript.requests.get("opcv2-ses_dispatch", "per_59"))
        ?.outcome?.role,
      "context",
    );
    assertEquals(f.diagnostics, []);
  } finally {
    await f.close();
  }
});

test("V2 metadata refresh coalesces off dispatch and only publishes the newest keyed state", async () => {
  const f = await fixture(), release = Promise.withResolvers<void>();
  try {
    f.hold(release.promise);
    f.send({ type: "session.renamed", data: { sessionID: "ses_dispatch" } });
    await until(() => f.calls.includes("/api/session/ses_dispatch"));
    for (let i = 0; i < 60; i++) {
      f.send({ type: "session.renamed", data: { sessionID: "ses_dispatch" } });
    }
    f.send({
      type: "session.message.content.updated",
      data: {
        sessionID: "ses_dispatch",
        messageID: "msg_marker",
      },
    });
    await bounded(
      "transcript bypasses held metadata refresh",
      until(() => f.events.includes("session.message.content.updated")),
    );
    f.native.title = "Final native title";
    release.resolve();
    await until(() =>
      f.index.getMetadata("opcv2-ses_dispatch")?.title === f.native.title
    );
    assertEquals(
      f.calls.filter((path) => path === "/api/session/ses_dispatch").length,
      2,
    );
    assertEquals(
      f.calls.filter((path) => path.endsWith("/message")),
      [],
      "Metadata refresh never scans history",
    );
    assertEquals(f.diagnostics, []);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("V2 background inventory cannot retire or stale requests that arrived during its read", async () => {
  const f = await fixture(), release = Promise.withResolvers<void>();
  try {
    f.locations.push({ directory: "/repo" });
    f.holdInventory(release.promise);
    f.send({ type: "project.updated", data: {} });
    await until(() => f.calls.includes("/api/permission/request"));
    f.send({
      type: "permission.asked",
      data: {
        sessionID: "ses_dispatch",
        id: "per_new",
        action: "read",
        resources: ["README.md"],
      },
    });
    f.send({
      type: "form.created",
      data: {
        form: {
          sessionID: "ses_dispatch",
          id: "frm_new",
          title: "New form",
          fields: [],
        },
      },
    });
    f.send({
      type: "session.message.content.updated",
      data: {
        sessionID: "ses_dispatch",
        messageID: "msg_marker",
      },
    });
    await until(() => f.events.includes("session.message.content.updated"));
    const published = f.publications;
    release.resolve();
    await until(() =>
      f.calls.includes("/api/form") && f.publications > published
    );
    assertEquals(
      (await f.adapter.capabilities.permissions!.listPermissions(
        "opcv2-ses_dispatch",
      )).map((request) => request.id),
      ["per_new"],
    );
    const forms = await f.adapter.capabilities.forms!.list({
      sessionID: "opcv2-ses_dispatch",
    });
    assertEquals(
      forms.map((request) => [request.id, request.fresh !== false]),
      [[
        "frm_new",
        true,
      ]],
    );
    assertEquals(
      f.index.getMetadata("opcv2-ses_dispatch")?.attention.permissions,
      1,
    );
    assertEquals(
      f.index.getMetadata("opcv2-ses_dispatch")?.attention.questions,
      1,
    );
    assertEquals(f.diagnostics, []);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("V2 deletion fences a held metadata refresh rather than reviving its session", async () => {
  const f = await fixture(), release = Promise.withResolvers<void>();
  try {
    f.hold(release.promise);
    f.send({ type: "session.renamed", data: { sessionID: "ses_dispatch" } });
    await until(() => f.calls.includes("/api/session/ses_dispatch"));
    f.send({ type: "session.deleted", data: { sessionID: "ses_dispatch" } });
    f.send({
      type: "session.message.content.updated",
      data: { sessionID: "ses_dispatch", messageID: "msg_marker" },
    });
    await until(() => f.events.includes("session.message.content.updated"));
    assertEquals(f.index.getMetadata("opcv2-ses_dispatch"), undefined);
    release.resolve();
    await f.adapter.core.stop();
    assertEquals(f.index.getMetadata("opcv2-ses_dispatch"), undefined);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("V2 pending attention follows topology learned outside native-event metadata refresh", async () => {
  const f = await fixture();
  try {
    const child = f.index.getMetadata("opcv2-ses_dispatch")!;
    const parent = { ...child, id: "opcv2-ses_parent", title: "Parent" };
    f.index.upsertMetadata(parent);
    f.send({
      type: "permission.asked",
      data: {
        sessionID: "ses_dispatch",
        id: "per_topology",
        action: "read",
        resources: ["README.md"],
      },
    });
    await until(() =>
      f.index.getMetadata(child.id)?.attention.permissions === 1
    );
    f.index.upsertMetadata({
      ...f.index.getMetadata(child.id)!,
      parentID: parent.id,
    });
    assertEquals(f.index.getMetadata(parent.id)?.attention.childPermissions, 1);
    f.index.upsertMetadata({
      ...f.index.getMetadata(child.id)!,
      parentID: undefined,
    });
    assertEquals(f.index.getMetadata(parent.id)?.attention.childPermissions, 0);
    assertEquals(f.index.getMetadata(child.id)?.attention.permissions, 1);
  } finally {
    await f.close();
  }
});

test("V2 pending permission waits for its native owner's routing topology", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  try {
    const child = f.index.getMetadata("opcv2-ses_dispatch")!;
    const parent = { ...child, id: "opcv2-ses_parent", title: "Parent" };
    f.index.upsertMetadata(parent);
    f.index.remove(child.id);
    f.hold(release.promise);
    f.send({
      type: "permission.asked",
      location: { directory: child.directory },
      data: {
        sessionID: "ses_dispatch",
        id: "per_early",
        action: "read",
        resources: ["README.md"],
      },
    });
    await until(() => f.events.includes("permission.asked"));
    assertEquals(f.permissionPublications, []);
    f.index.upsertMetadata({ ...child, parentID: parent.id });
    assertEquals(f.permissionPublications, [
      { id: child.id, ancestors: [parent.id] },
    ]);
  } finally {
    release.resolve();
    await f.close();
  }
});
