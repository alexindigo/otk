// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { test } from "../support/resources.ts";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import type { ContentSession } from "@otk/protocol";
import type { InboxSnapshot, TaskRecord } from "@otk/protocol";
import { waitFor } from "../support/opencode.ts";

test("busy revert reports the real native reason through the RPC error mapper without JSON", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  const held = f.fake.queueHeld({ chunks: ["Working until interrupted."] });
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Busy rollback reason" },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("session.prompt", {
      sessionID: s.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Keep working" }],
      model: { provider: "fake", model: "scripted" },
    });
    await waitFor(
      () => f.oc.request<Record<string, { type: string }>>("/session/status"),
      (status) => status[s.id]?.type === "busy",
    );
    const messages = await f.oc.request<
      { info: { id: string; role: string } }[]
    >(`/session/${s.id}/message`);
    const messageID = messages.find((message) =>
      message.info.role === "user"
    )!.info.id;
    const error = await assertRejects(
      () => client!.rpc("session.revert", { sessionID: s.id, messageID }),
      Error,
    );
    assertEquals(
      error.message,
      "harness_409: The session is working. Try again when it finishes.",
    );
  } finally {
    held.release();
    await client?.close();
    await f.stop();
  }
});

test("restore returns rolled-back prompts to the real native conversation", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Restore source" },
    });
    const first = await f.oc.request<{ info: { id: string } }>(
      `/session/${session.id}/message`,
      {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: "Boundary prompt" }],
        },
      },
    );
    await f.oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: { noReply: true, parts: [{ type: "text", text: "Later prompt" }] },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const reverted = await client.rpc<ContentSession>("session.revert", {
      sessionID: session.id,
      messageID: first.info.id,
    });
    assertEquals(reverted.revert?.prompts?.map((p) => p.preview), [
      "Boundary prompt",
      "Later prompt",
    ]);
    assertEquals(reverted.revert?.prompt?.input, "Boundary prompt");
    assertEquals(
      await client.rpc("session.messages", {
        sessionID: session.id,
        limit: 100,
      }),
      [],
    );
    const restored = await client.rpc<ContentSession>("session.restore", {
      sessionID: session.id,
    });
    assertEquals(restored.revert, undefined);
    assertEquals(
      (await client.rpc<unknown[]>("session.messages", {
        sessionID: session.id,
        limit: 100,
      })).length,
      2,
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});

test("fork copies through a grouped reply, respects pending rollback and activates its project", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const original = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Fork source" },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    for (const [index, text] of ["First prompt", "Second prompt"].entries()) {
      f.fake.queue({ chunks: [`Reply to ${text}`] });
      await client.rpc("session.prompt", {
        sessionID: original.id,
        mode: "normal",
        parts: [{ kind: "text", text }],
        model: { provider: "fake", model: "scripted" },
      });
      await waitFor(
        () =>
          f.oc.request<
            { info: { role: string; time: { completed?: number } } }[]
          >(`/session/${original.id}/message`),
        (messages) =>
          messages.length === (index + 1) * 2 &&
          messages.at(-1)?.info.role === "assistant" &&
          messages.at(-1)?.info.time.completed !== undefined,
      );
    }
    const messages = await f.oc.request<
      { info: { id: string }; parts: { type: string; text?: string }[] }[]
    >(`/session/${original.id}/message`);
    const text = (rows: typeof messages) =>
      rows.flatMap((m) =>
        m.parts.filter((p) => p.type === "text").map((p) => p.text)
      );
    const fork = await client.rpc<ContentSession>("session.fork", {
      sessionID: original.id,
      through: messages[1].info.id,
    });
    assertEquals(
      text(await f.oc.request(`/session/${fork.id}/message`)),
      text(messages.slice(0, 2)),
    );
    const all = await client.rpc<ContentSession>("session.fork", {
      sessionID: original.id,
      through: messages.at(-1)!.info.id,
    });
    assertEquals(
      text(await f.oc.request(`/session/${all.id}/message`)),
      text(messages),
    );
    await client.rpc("projects.inactive", {
      directory: f.oc.directory,
      inactive: true,
    });
    await client.rpc("session.revert", {
      sessionID: original.id,
      messageID: messages[2].info.id,
    });
    const visible = await client.rpc<ContentSession>("session.fork", {
      sessionID: original.id,
    });
    assertEquals(
      text(await f.oc.request(`/session/${visible.id}/message`)),
      text(messages.slice(0, 2)),
    );
    const inbox = await client.rpc<InboxSnapshot>("inbox.get", {});
    assertEquals(
      inbox.projects.find((p) => p.directory === f.oc.directory)?.inactive,
      false,
    );
    await assertRejects(
      () =>
        client!.rpc("session.fork", { sessionID: original.id, through: 42 }),
      Error,
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});

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

test("compact admits native summarization and publishes a terminal compaction message", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Compact source" },
    });
    await f.oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "Context to summarize" }],
        model: { providerID: "fake", modelID: "scripted" },
      },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    f.fake.queue({ chunks: ["Compaction summary."] });
    const start = performance.now();
    assertEquals(
      await client.rpc("session.compact", {
        sessionID: session.id,
        model: { provider: "fake", model: "scripted" },
      }),
      null,
    );
    assertEquals(performance.now() - start < 5_000, true);
    const messages = await waitFor(
      () =>
        f.oc.request<
          {
            info: { role: string; time: { completed?: number } };
            parts: { type: string; text?: string }[];
          }[]
        >(`/session/${session.id}/message`),
      (messages) =>
        messages.some((m) =>
          m.info.role === "assistant" && m.info.time.completed !== undefined &&
          m.parts.some((p) =>
            p.type === "text" && p.text === "Compaction summary."
          )
        ),
    );
    assertEquals(
      messages.some((m) => m.parts.some((p) => p.type === "compaction")),
      true,
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});
