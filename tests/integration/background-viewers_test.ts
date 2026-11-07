// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { start } from "../../main.ts";
import { InboxFeature } from "../../core/features/inbox.ts";
import type { DigestPressure } from "../../core/digest/protocol.ts";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, OpencodeTest, waitFor } from "../support/opencode.ts";
import { resources, test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("@load @transport view leases park unfinished backfill without holding execution, native permission or credit; SSE lamps and resume survive", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const session = await oc.session<{ id: string; nativeID: string }>(
    "/session",
    {
      method: "POST",
      body: { title: "Unfinished backfill" },
    },
  );
  for (let i = 0; i < 3; i++) {
    fake.queue({ chunks: [`Reply ${i}`] });
    await oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: { parts: [{ type: "text", text: `Prompt ${i}` }] },
    });
  }
  let hold = true, entered = 0, settled = 0, optionalReads = 0;
  const requests: string[] = [];
  const proxy = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      const optional = url.pathname.endsWith("/message") &&
        url.searchParams.get("limit") === "2";
      requests.push(optional ? "background" : url.pathname);
      if (optional) optionalReads++;
      if (optional && hold) {
        entered++;
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else {request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });}
        });
        settled++;
        return Response.json([]);
      }
      return fetch(new URL(url.pathname + url.search, oc.url), {
        signal: request.signal,
      });
    },
  );
  resources().defer("viewer proxy", () => proxy.shutdown());
  const settings = cfg();
  settings.auth.type = "none";
  settings.server.port = freePort();
  settings.state.path = join(oc.root, "viewer-state");
  settings.harness.url = `http://127.0.0.1:${proxy.addr.port}`;
  settings.harness.db = join(oc.root, "absent.db");
  settings.digest = { ...settings.digest, batch: 2, cpu: 1, publishrows: 2 };
  const pressure: DigestPressure[] = [];
  const app = await start(settings, {
    section() {},
    pressure: (value) => pressure.push(value),
  });
  const url = `http://127.0.0.1:${settings.server.port}`;
  const client = new WsClient(url);
  let next: WsClient | undefined;
  const busy = fake.queueHeld({ chunks: ["Still working with no browser"] });
  try {
    client.lease({
      directory: oc.directory,
      selected: session.id,
      crumbs: [],
      rows: [],
    });
    await client.connect();
    // Selection parks backfill until the first page is accepted by its consumer.
    await client.rpc("prefs.get", {});
    assertEquals(entered, 0);
    const at = requests.length;
    const page = await client.rpc<{ items: unknown[] }>("session.messages", {
      sessionID: session.id,
    });
    assert(page.items.length > 0);
    await waitFor(() => entered, (n) => n > 0);
    const since = requests.slice(at);
    assert(since.findIndex((path) => path.endsWith("/message")) >= 0);
    const firstPage = since.findIndex((path) => path.endsWith("/message"));
    const firstBackground = since.indexOf("background");
    assert(
      firstBackground < 0 || firstPage < firstBackground,
      JSON.stringify(since),
    );
    await client.close();
    await waitFor(() => settled, (n) => n === entered);
    await waitFor(
      () => pressure.at(-1),
      (value) =>
        !!value && value.queued > 0 && value.active === 0 &&
        value.nativeActive === 0 &&
        value.publicationWaiting === 0 && value.heldCredits === 0,
    );
    const paused = pressure.at(-1)!;
    const pausedReads = optionalReads;
    const revision = app.index.get(session.id)!.digest.revision;
    const inbox = app.connections.sources.find((source) =>
      source instanceof InboxFeature
    );
    assert(inbox instanceof InboxFeature);
    await oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Run with no viewers" }] },
    });
    await waitFor(
      () => inbox.summaries.values.get(oc.directory)?.status,
      (status) => status === "working",
    );
    assertEquals(optionalReads, pausedReads);
    assertEquals(app.index.get(session.id)!.digest.revision, revision);
    busy.release();
    await waitFor(
      () => inbox.summaries.values.get(oc.directory)?.unseenCount,
      (n) => (n ?? 0) > 0,
    );
    assertEquals(optionalReads, pausedReads);
    fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf p6",
          description: "Manual permission while disconnected",
        },
      },
    });
    await oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: {
        parts: [{ type: "text", text: "Ask for permission without a viewer" }],
      },
    });
    await waitFor(
      () => inbox.summaries.values.get(oc.directory)?.status,
      (status) => status === "blocked",
    );
    assertEquals(optionalReads, pausedReads);
    hold = false;
    next = new WsClient(url);
    next.lease({
      directory: oc.directory,
      selected: session.id,
      crumbs: [],
      rows: [],
    });
    await next.connect();
    await next.rpc("session.messages", { sessionID: session.id });
    await waitFor(
      () => app.index.get(session.id)?.digest.state,
      (state) => state === "ready",
    );
    assert(optionalReads > pausedReads);
    console.info("VIEWER BACKFILL CONTRACT", {
      pausedReads,
      resumedReads: optionalReads,
      entered,
      settled,
      paused,
    });
  } finally {
    console.info("VIEWER CONTRACT TRACE", {
      requests,
      entered,
      settled,
      pressure: pressure.slice(-12),
      frames: client.frames.slice(-8),
    });
    busy.release();
    await client.close();
    await next?.close();
    await app.stop();
    await oc.stop();
    await fake.stop();
  }
});
