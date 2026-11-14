// SPDX-License-Identifier: LGPL-3.0-only
import { readRpcMessages } from "../support/message-pages.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { RequestFailure } from "@otk/client";
import { test } from "../support/resources.ts";
import { nativeBehavior } from "../support/native-testing.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const v1Test = v1NativeTests(
  "V1 revert/fork/compaction transcript wire contracts",
  [
    "tests/integration/v2-session-actions_test.ts#OC2A1",
    "tests/integration/v2-session-actions_test.ts#OC2A2",
    "tests/integration/v2-session-actions_test.ts#OC2A3",
    "tests/integration/v2-session-actions_test.ts#OC2A4",
  ],
);
import { nativeFixture } from "../support/native-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import type { ContentSession } from "@otk/protocol";
import type { InboxSnapshot, TaskRecord } from "@otk/protocol";
import { waitFor } from "../support/opencode.ts";

v1Test(
  "busy revert reports structured native rejection facts without native prose",
  async () => {
    const f = await nativeFixture();
    let client: WsClient | undefined;
    const held = f.fake.queueHeld({ chunks: ["Working until interrupted."] });
    try {
      const s = await f.oc.session<{ id: string }>("/session", {
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
        (status) => status[s.nativeID]?.type === "busy",
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
      assert(error instanceof RequestFailure);
      assertEquals(error.failure.facts?.action, "session.revert");
      assertEquals(error.failure.facts?.target?.sessionID, s.id);
      assertEquals(error.failure.code, "session.busy");
    } finally {
      held.release();
      await client?.close();
      await f.stop();
    }
  },
);

v1Test(
  "restore returns rolled-back prompts to the real native conversation",
  async () => {
    const f = await nativeFixture();
    let client: WsClient | undefined;
    try {
      const session = await f.oc.session<{ id: string }>("/session", {
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
        body: {
          noReply: true,
          parts: [{ type: "text", text: "Later prompt" }],
        },
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
        await readRpcMessages(client, session.id),
        [],
      );
      const restored = await client.rpc<ContentSession>("session.restore", {
        sessionID: session.id,
      });
      assertEquals(restored.revert, undefined);
      assertEquals(
        (await readRpcMessages(client, session.id)).length,
        2,
      );
    } finally {
      await client?.close();
      await f.stop();
    }
  },
);

v1Test(
  "fork copies through a grouped reply, respects pending rollback and activates its project",
  async () => {
    const f = await nativeFixture();
    let client: WsClient | undefined;
    try {
      const original = await f.oc.session<{ id: string }>("/session", {
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
      const inbox =
        (await client.rpc<{ inbox: InboxSnapshot }>("inbox.get", {})).inbox;
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
  },
);

test("session rename validates titles and persists through the real native API", async () => {
  const f = await nativeBehavior();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.createSession("Original");
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
      Reflect.get(await f.oc.readSession(session.id) as object, "title"),
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

test("delete tombstones a real native family and retains task membership until explicit removal", async () => {
  const f = await nativeBehavior();
  let client: WsClient | undefined;
  try {
    const root = await f.oc.createSession("Delete family");
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect(f.oc.directory);
    const child = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Helper",
      parentID: root.id,
    });
    const task = await client.rpc<TaskRecord>("tasks.create", {
      directory: f.oc.directory,
      name: "Delete members",
      sessions: [root.id, child.id],
    });
    await client.rpc("session.delete", { sessionID: root.id });
    if (f.oc.kind === "opencode-v1") {
      for (const id of [root.id, child.id]) {
        await assertRejects(() => f.oc.readSession(id), Error, "404");
      }
    } else {assertEquals(
        await f.oc.listSessions(),
        [],
        "Stock V2 must have deleted the whole native family",
      );}
    await waitFor(
      () => [client!.entry(root.id), client!.entry(child.id)],
      (entries) => entries.every((entry) => entry?.deleted !== undefined),
    );
    assertEquals(client.entry(root.id)!.deleted!.how, "otk");
    assertEquals(client.entry(child.id)!.title, "Helper");
    const inbox =
      (await client.rpc<{ inbox: InboxSnapshot }>("inbox.get", {})).inbox;
    assertEquals(inbox.tasks.find((item) => item.id === task.id)?.sessions, [
      root.id,
      child.id,
    ]);
    assertEquals(
      client.frames.some((frame) =>
        frame.t === "index.patch" &&
        frame.ops.some((op) =>
          op.op === "remove" && [root.id, child.id].includes(op.id)
        )
      ),
      false,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await client.rpc("tasks.removeSession", {
        id: task.id,
        sessionID: root.id,
      });
      const updated =
        (await client.rpc<{ inbox: InboxSnapshot }>("inbox.get", {})).inbox;
      assertEquals(
        updated.tasks.find((item) => item.id === task.id)!.sessions,
        [child.id],
      );
    }
  } finally {
    await client?.close();
    await f.stop();
  }
});

v1Test(
  "compact admits native summarization and publishes a terminal compaction message",
  async () => {
    const f = await nativeFixture();
    let client: WsClient | undefined;
    try {
      const session = await f.oc.session<{ id: string }>("/session", {
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
            m.info.role === "assistant" &&
            m.info.time.completed !== undefined &&
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
  },
);
