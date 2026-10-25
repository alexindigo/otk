// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { test } from "../support/resources.ts";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import type { ContentSession } from "@otk/protocol";
import type { InboxSnapshot, TaskRecord } from "@otk/protocol";
import { waitFor } from "../support/opencode.ts";

test("session rename validates titles and persists through the real native API", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Original" },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const renamed = await client.rpc<ContentSession>("session.rename", {
      sessionID: session.id,
      title: "  A precise title  ",
    });
    assertEquals(renamed.title, "A precise title");
    assertEquals(renamed.directory, f.oc.directory);
    assertEquals(
      (await f.oc.request<{ title: string }>(`/session/${session.id}`)).title,
      "A precise title",
    );
    for (const title of ["", "   ", "x".repeat(201), null, 42]) {
      await assertRejects(() =>
        client!.rpc("session.rename", {
          sessionID: session.id,
          title,
        }), Error);
    }
    await assertRejects(() =>
      client!.rpc("session.rename", {
        sessionID: "",
        title: "Valid",
      }), Error);
    assertEquals(
      (await client.rpc<ContentSession>("session.get", {
        sessionID: session.id,
      }))
        .title,
      "A precise title",
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});

test("delete removes a real native family and committed task membership", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Delete family" },
    });
    const child = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Helper", parentID: root.id },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const task = await client.rpc<TaskRecord>("tasks.create", {
      directory: f.oc.directory,
      name: "Delete members",
      sessions: [root.id, child.id],
    });
    await client.rpc("session.delete", { sessionID: root.id });
    for (const id of [root.id, child.id]) {
      await assertRejects(() => f.oc.request(`/session/${id}`), Error, "404");
    }
    const inbox = await waitFor(
      () => client!.rpc<InboxSnapshot>("inbox.get", {}),
      (inbox) =>
        inbox.tasks.find((item) => item.id === task.id)?.sessions.length === 0,
    );
    assertEquals(inbox.tasks.find((item) => item.id === task.id)?.sessions, []);
  } finally {
    await client?.close();
    await f.stop();
  }
});
