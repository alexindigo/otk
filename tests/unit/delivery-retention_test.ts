// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type DigestPort, SessionIndex } from "@otk/harness";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import type { DeliveredEvidence } from "@otk/protocol";
import { SessionSupervision } from "../../core/index/supervision.ts";
import { cfg } from "../support/config.ts";
import { tempDir, test } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";

test("V2 inventory resyncs keep durable delivery; only the store can change it", async () => {
  const root = await tempDir("delivery-retention-");
  const index = new SessionIndex(), child = "opcv2-ses_child";
  const natives = new Map([
    ["ses_parent", {
      id: "ses_parent",
      projectID: "p",
      location: { directory: "/fixture" },
      title: "Parent",
      time: { created: 1, updated: 300 },
    }],
    ["ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      projectID: "p",
      location: { directory: "/fixture" },
      title: "Helper",
      time: { created: 1, updated: 200, idle: 200 },
      outcome: "succeeded",
    }],
  ]);
  const fact: DeliveredEvidence = {
    parentID: "opcv2-ses_parent",
    receipt: "msg_report",
    terminal: 200,
  };
  // The digest store's durable facts. Backfill pages replay them only once:
  // a later covered parent has nothing new to page through.
  const store = new Map([[child, fact]]);
  let replay = true, joins = 0;
  const digest: DigestPort = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    projects: () => Promise.resolve({ projects: [] }),
    catalog: () => Promise.reject(new Error("No ordinary catalog demand")),
    read: ((kind, input) => {
      if (kind === "supervision.terminals") {
        return Promise.resolve(
          (input as { after: string }).after ? [] : [{
            id: child,
            parentID: "opcv2-ses_parent",
            directory: "/fixture",
            projectID: "p",
            title: "Helper",
            timeCreated: 1,
            timeUpdated: 200,
            archived: false,
            status: "idle",
            activity: { terminal: 200, outcome: "succeeded" },
            attention: {
              permissions: 0,
              questions: 0,
              childPermissions: 0,
              childQuestions: 0,
            },
          }],
        );
      }
      if (kind === "opcv2.sessions") {
        return Promise.resolve(
          (input as { ids: string[] }).ids.flatMap((id) => {
            const raw = natives.get(id.replace(/^opcv2-/, ""));
            return raw ? [raw] : [];
          }),
        );
      }
      if (kind === "supervision.deliveries") {
        const updates = replay
          ? [...store].map(([id, delivered]) => ({ id, delivered }))
          : [];
        replay = false;
        return Promise.resolve({ updates });
      }
      if (kind === "supervision.delivered") {
        joins++;
        return Promise.resolve(
          (input as { ids: string[] }).ids.flatMap((id) => {
            const delivered = store.get(id);
            return delivered ? [{ id, delivered }] : [];
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected read ${kind}`));
    }) as DigestPort["read"],
    detail: () => Promise.reject(new Error("No usage demand")),
    transcriptMetadata: () => Promise.reject(new Error("No body demand")),
    observe() {},
    scope() {},
    release() {},
    deleted: () => Promise.resolve(),
    deleteIntent: () => Promise.resolve(),
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/info") {
        return Response.json({ version: "2.2.6", pid: 42 });
      }
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (path === "/api/debug/location") {
        return Response.json([{ directory: "/fixture" }]);
      }
      if (
        path === "/api/shell" || path === "/api/permission/request" ||
        path === "/api/form"
      ) {
        return Response.json({ location: { directory: "/fixture" }, data: [] });
      }
      const session = /^\/api\/session\/([^/]+)$/.exec(path);
      if (session && natives.has(session[1])) {
        return Response.json({ data: natives.get(session[1]) });
      }
      if (path === "/api/event") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"type":"server.connected","data":{}}\n\n',
              ));
              request.signal.addEventListener("abort", () => {
                try {
                  controller.close();
                } catch { /* already closed */ }
              }, { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 404 });
    },
  );
  const serviceFile = root + "/service.json", settings = cfg();
  await Deno.writeTextFile(
    serviceFile,
    JSON.stringify({
      url: `http://127.0.0.1:${server.addr.port}`,
      version: "2.2.6",
      pid: 42,
    }),
  );
  const adapter = new OpencodeV2ServerAdapter(
    { serviceFile, harness: settings.harness, messages: settings.messages },
    undefined,
    () => {},
    fetch,
    digest,
  );
  const supervision = new SessionSupervision();
  const unseen = () => supervision.session(index.getMetadata(child)!, 0).unseen;
  const signal = new AbortController().signal;
  try {
    await adapter.core.start({
      index,
      retainedSessions: [child],
      connection() {},
      indexReset() {},
      indexRemove() {},
      content() {},
      invalidate() {},
      bootstrapComplete() {},
      indexUpsert: (entry) => index.upsertMetadata(entry),
    });
    await waitFor(
      () => Promise.resolve(index.getMetadata(child)?.activity?.delivered),
      Boolean,
    );
    assertEquals(unseen(), false);
    // Permission, form and project events resync inventories without
    // reconnecting; none of them may erase the store's delivered fact.
    for (
      const event of [
        {
          type: "permission.replied",
          created: 400,
          data: { sessionID: "ses_parent", requestID: "per_1", reply: "once" },
        },
        {
          type: "form.cancelled",
          created: 401,
          data: { sessionID: "ses_parent", id: "frm_1" },
        },
        { type: "project.updated", created: 402, data: {} },
      ]
    ) {
      await adapter.stream.ports.event(event, adapter.stream.client, signal, 1);
      assertEquals(index.getMetadata(child)?.activity?.delivered, fact);
      assertEquals(unseen(), false, event.type);
    }
    // The covered terminal needs no further join; a newer run does.
    const settled = joins;
    natives.get("ses_child")!.time = { created: 1, updated: 500, idle: 500 };
    await adapter.stream.ports.event(
      { type: "project.updated", created: 500, data: {} },
      adapter.stream.client,
      signal,
      1,
    );
    await waitFor(() => Promise.resolve(joins), (n) => n > settled);
    assertEquals(index.getMetadata(child)?.activity?.terminal, 500);
    assertEquals(unseen(), true, "an older report never covers a newer run");
    // Only the store retires a fact, e.g. after source replacement.
    store.set(child, { ...fact, receipt: "msg_later", terminal: 500 });
    await adapter.stream.ports.event(
      { type: "project.updated", created: 501, data: {} },
      adapter.stream.client,
      signal,
      1,
    );
    await waitFor(() => Promise.resolve(unseen()), (value) => !value);
  } finally {
    await adapter.core.stop();
    await server.shutdown();
  }
});
