// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { nativeFixture } from "../support/native-fixture.ts";
import { seedBrowserSession } from "../support/browser-native.ts";
import { waitFor } from "../support/opencode.ts";
import { withResources } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";
import { join } from "@std/path";

Deno.test("browser native pending authority follows newly loaded nested project locations", () =>
  withResources("nested project attention", async () => {
    const f = await nativeFixture({ bash: "ask" });
    const server = await f.sidecar();
    const directory = join(f.oc.root, "sibling-project");
    await Deno.mkdir(directory);
    const parent = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      directory,
      body: { title: "Nested parent" },
    });
    const child = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      directory,
      body: { title: "Nested helper", parentID: parent.id },
    });
    const client = new WsClient(server.url);
    try {
      await client.connect(directory, parent.id);
      await client.rpc("session.messages", { sessionID: parent.id });
      f.fake.queue({
        tool: {
          name: "bash",
          input: {
            command: "printf nested-attention",
            description: "Nested permission",
          },
        },
      }, { chunks: ["Nested completed."] });
      await f.oc.request(`/session/${child.id}/prompt_async`, {
        method: "POST",
        directory,
        body: { parts: [{ type: "text", text: "Ask in a nested location" }] },
      });
      await waitFor(
        () => f.oc.listPermissions(child.id),
        (rows) => rows.length === 1,
      );
      const pending = await waitFor(
        () =>
          client.rpc<{ id: string }[]>("permission.list", {
            sessionID: parent.id,
          }),
        (rows) => rows.length === 1,
        5000,
      );
      assertEquals(pending.length, 1);
      await client.rpc("permission.reply", {
        sessionID: child.id,
        requestID: pending[0].id,
        reply: "once",
      });
    } finally {
      await client.close();
    }
  }));

Deno.test("browser native facade seeds projected prompts and completes a real scripted turn", () =>
  withResources("browser native seed", async () => {
    const f = await nativeFixture({ bash: "allow" });
    f.fake.strict();
    const seeded = await seedBrowserSession(f.oc, {
      title: "Browser seed",
      messages: Array.from(
        { length: 12 },
        (_, n) => ({ parts: [{ type: "text", text: `Seed ${n}` }] }),
      ),
    });
    const rows = await f.oc.request<
      { info: { role: string }; parts: { text: string }[] }[]
    >(`/session/${seeded.id}/message`);
    assertEquals(rows.length, 12);
    assertEquals(
      rows.map((r) => r.parts[0].text),
      Array.from({ length: 12 }, (_, n) => `Seed ${n}`),
    );
    f.fake.queue({ chunks: ["Browser facade result."] });
    await f.oc.request(`/session/${seeded.id}/message`, {
      method: "POST",
      body: {
        parts: [{ type: "text", text: "Continue the imported session" }],
      },
    });
    const after = await f.oc.request<unknown[]>(
      `/session/${seeded.id}/message`,
    );
    assertStringIncludes(JSON.stringify(after), "Browser facade result.");
    assertEquals(f.fake.unexpected, 0);
    assertEquals(f.fake.pending, 0);
  }));

Deno.test("browser native facade routes asking-session permissions", () =>
  withResources("browser native permission", async () => {
    const f = await nativeFixture({ bash: "ask" });
    f.fake.strict();
    const root = await f.oc.createSession("Browser permission");
    f.fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf browser-permission",
          description: "Browser permission proof",
        },
      },
    }, { chunks: ["Permission completed."] });
    await f.oc.request(`/session/${root.id}/prompt_async`, {
      method: "POST",
      body: {
        parts: [{ type: "text", text: "Run the controlled shell command" }],
      },
    });
    const pending = await waitFor(
      () => f.oc.listPermissions(root.id),
      (rows) => rows.length === 1,
    );
    assertEquals(pending[0].sessionID, root.id);
    await f.oc.replyPermission(root.id, pending[0].id, "once");
    await waitFor(
      () => f.oc.request<Record<string, unknown>>("/session/status"),
      (rows) => !Object.keys(rows).length,
    );
    assertStringIncludes(
      JSON.stringify(await f.oc.readMessages(root.id, 200)),
      "Permission completed.",
    );
  }));

Deno.test("browser native facade restart keeps managed discovery and transcript identity", () =>
  withResources("browser native restart", async () => {
    const f = await nativeFixture();
    const root = await f.oc.createSession("Browser restart");
    const old = f.oc.process.pid;
    const port = f.oc.port;
    await f.oc.restart();
    assert(f.oc.process.pid !== old);
    assertEquals(f.oc.port, port);
    assertEquals(
      (await f.oc.sessionList<{ id: string }>("/session"))[0].id,
      root.id,
    );
    const server = await f.sidecar();
    const client = new WsClient(server.url);
    try {
      await client.connect();
      assertEquals(
        (await client.rpc<{ title: string }>("session.get", {
          sessionID: root.id,
        })).title,
        "Browser restart",
      );
    } finally {
      await client.close();
    }
  }));

Deno.test("browser native pending requests reach a selected parent while the helper is working", () =>
  withResources("browser native selected attention", async () => {
    const f = await nativeFixture({ bash: "ask" });
    f.fake.strict();
    const parent = await f.oc.createSession("Selected parent");
    const child = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Asking helper", parentID: parent.id },
    });
    const server = await f.sidecar();
    const client = new WsClient(server.url);
    try {
      await client.connect(f.oc.directory, parent.id);
      await client.rpc("session.messages", { sessionID: parent.id });
      f.fake.queue({
        tool: {
          name: "bash",
          input: {
            command: "printf attention",
            description: "Attention proof",
          },
        },
      }, { chunks: ["Attention completed."] });
      await f.oc.request(`/session/${child.id}/prompt_async`, {
        method: "POST",
        body: { parts: [{ type: "text", text: "Ask before running" }] },
      });
      await waitFor(
        () => f.oc.listPermissions(child.id),
        (rows) => rows.length === 1,
      );
      const pending = await waitFor(
        () =>
          client.rpc<{ id: string }[]>("permission.list", {
            sessionID: parent.id,
          }),
        (rows) => rows.length === 1,
        10000,
      );
      await client.rpc("permission.reply", {
        sessionID: child.id,
        requestID: pending[0].id,
        reply: "once",
      });
      await waitFor(
        () => f.oc.request<Record<string, unknown>>("/session/status"),
        (rows) => !Object.keys(rows).length,
      );
    } finally {
      await client.close();
    }
  }));

Deno.test("browser native compaction reports busy until its held provider settles", () =>
  withResources("browser native compact activity", async () => {
    const f = await nativeFixture({ bash: "allow" });
    f.fake.strict();
    const session = await seedBrowserSession(f.oc, {
      title: "Compact activity",
      messages: [{ parts: [{ type: "text", text: "Context to summarize" }] }],
    });
    const server = await f.sidecar(), client = new WsClient(server.url);
    const held = f.fake.queueHeld({
      chunks: ["## Objective\n\nHeld compaction summary."],
    });
    let work: Promise<unknown> | undefined;
    try {
      await client.connect(f.oc.directory, session.id);
      await client.rpc("session.messages", { sessionID: session.id });
      work = client.rpc("session.compact", {
        sessionID: session.id,
        model: { provider: "fake", model: "scripted" },
      });
      void work.catch(() => {});
      await waitFor(() => f.fake.active, (n) => n === 1);
      await waitFor(
        () => client.entry(session.id)?.status,
        (status) => status === "busy",
        5000,
      );
      held.release();
      await work;
      await waitFor(
        () => client.entry(session.id)?.status,
        (status) => status === "idle",
      );
      assertEquals(f.fake.unexpected, 0);
    } finally {
      held.release();
      await work?.catch(() => {});
      await client.close();
    }
  }));

for (const source of ["native-db", "api"] as const) {
  Deno.test(`browser helper activity uses shared tool names from ${source}`, () =>
    withResources(`browser helper names ${source}`, async () => {
      const f = await nativeFixture({ bash: "ask" });
      f.fake.strict();
      const session = await f.oc.createSession("Canonical helper activity");
      const server = await f.sidecar(
        source === "api"
          ? { harness: { db: join(f.oc.root, "missing-native.db") } }
          : {},
      );
      const client = new WsClient(server.url);
      try {
        await client.connect(f.oc.directory, session.id);
        client.send({ t: "subscribe", sessionID: session.id });
        await client.rpc("session.messages", { sessionID: session.id });
        f.fake.queue(
          {
            tool: {
              name: "task",
              input: {
                subagent_type: "general",
                description: "Helper naming proof",
                prompt: "Run the shell probe",
              },
            },
          },
          {
            tool: {
              name: "bash",
              input: {
                command: "printf helper-name",
                description: "Helper shell probe",
              },
            },
          },
          { chunks: ["Child done."] },
          { chunks: ["Parent done."] },
        );
        await f.oc.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          body: { parts: [{ type: "text", text: "Delegate to the helper" }] },
        });
        const progress = await waitFor(
          () =>
            client.frames.flatMap((frame) => {
              if (frame.t !== "content") return [];
              const event = frame.event;
              if (event.op === "task.progress") {
                return event.summary.current ? [event.summary] : [];
              }
              const parts = event.op === "message.upsert"
                ? event.message.parts
                : event.op === "part.upsert"
                ? [event.part]
                : [];
              return parts.flatMap((part) =>
                part.kind === "tool" && part.call.tool === "task" &&
                  part.call.progress?.current
                  ? [part.call.progress]
                  : []
              );
            }).at(-1),
          (summary) => !!summary,
          10000,
        );
        assertEquals(progress!.current!.name, "bash");
        const pending = await waitFor(
          () =>
            client.rpc<{ id: string; sessionID: string }[]>("permission.list", {
              sessionID: session.id,
            }),
          (rows) => rows.length === 1,
        );
        await client.rpc("permission.reply", {
          sessionID: pending[0].sessionID,
          requestID: pending[0].id,
          reply: "once",
        });
        await waitFor(
          () => f.oc.request<Record<string, unknown>>("/session/status"),
          (rows) => !Object.keys(rows).length,
        );
        assertEquals(f.fake.unexpected, 0);
      } finally {
        await client.close();
      }
    }));
}
