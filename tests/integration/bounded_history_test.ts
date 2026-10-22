// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type Info,
  Opencode1Adapter,
  type RawPart,
  type Session,
} from "@otk/harness-opencode1";
import { Frecency, frecencyMigrations, OtkDb } from "@otk/store";
import {
  frecencyOptions,
  registerFrecency,
  RpcRegistry,
} from "../../core/mod.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";

test("stock WAL metadata and bounded API fallback reach revert, task cards and authoritative @ ranking", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake);
  const adapters: Opencode1Adapter[] = [];
  const store = new OtkDb(join(oc.root, "otk"), [frecencyMigrations]);
  try {
    const parent = await oc.request<Session>("/session", {
      method: "POST",
      body: { title: "Bounded parent" },
    });
    const child = await oc.request<Session>("/session", {
      method: "POST",
      body: { title: "Bounded child", parentID: parent.id },
    });
    const users: string[] = [];
    for (let i = 0; i < 3; i++) {
      const message = await oc.request<{ info: Info }>(
        `/session/${parent.id}/message`,
        {
          method: "POST",
          body: {
            noReply: true,
            parts: [{ type: "text", text: `Prompt ${i}` }],
          },
        },
      );
      users.push(message.info.id);
    }
    await oc.request(`/session/${child.id}/message`, {
      method: "POST",
      body: { noReply: true, parts: [{ type: "text", text: "Child prompt" }] },
    });
    await oc.request(`/session/${child.id}/shell`, {
      method: "POST",
      body: { agent: "build", command: "printf child-summary" },
    });
    const childMessages = await oc.request<{ info: Info; parts: RawPart[] }[]>(
      `/session/${child.id}/message?limit=200`,
    );
    const tools = childMessages.flatMap((item) => item.parts).filter((part) =>
      part.type === "tool"
    );
    assertEquals(tools.length, 1);
    // A stock persisted task part, updated by the documented stock API.
    const shell = await oc.request<{ info: Info; parts: RawPart[] }>(
      `/session/${parent.id}/shell`,
      {
        method: "POST",
        body: { agent: "build", command: "printf parent-task" },
      },
    );
    const original = shell.parts.find((part) => part.type === "tool")!;
    await oc.request(
      `/session/${parent.id}/message/${shell.info.id}/part/${original.id}`,
      {
        method: "PATCH",
        body: {
          ...original,
          tool: "task",
          state: {
            ...original.state,
            input: {
              description: "Inspection",
              subagent_type: "general",
              prompt: "Inspect",
            },
            metadata: { sessionId: child.id },
          },
        },
      },
    );
    await oc.request(`/session/${parent.id}/revert`, {
      method: "POST",
      body: { messageID: users[1] },
    });
    const reads: URL[] = [];
    for (const mode of ["SQL", "API"]) {
      const adapter = new Opencode1Adapter(
        {
          harness: {
            url: oc.url,
            username: "opencode",
            password: "",
            db: mode === "SQL" ? oc.db : join(oc.root, "missing.db"),
            heartbeattimeout: 25,
            reconnectmax: 30,
          },
          index: { days: 30 },
        },
        undefined,
        (input, options) => {
          const url = new URL(String(input));
          if (
            /\/message$/.test(url.pathname) &&
            (!options?.method || options.method === "GET")
          ) {
            const limit = Number(url.searchParams.get("limit"));
            assert(limit > 0 && limit <= 200, `Unbounded request: ${url}`);
          }
          reads.push(url);
          return fetch(input, options);
        },
      );
      adapters.push(adapter);
      assertEquals(
        (await adapter.core.getSession(parent.id)).revert?.messageCount,
        3,
      );
      const frecency = new Frecency(store, frecencyOptions);
      const rpc = new RpcRegistry(adapter, store);
      registerFrecency(rpc, adapter, frecency);
      await rpc.dispatch("frecency.bump", {
        sessionID: parent.id,
        directory: "/forged",
        path: "README.md",
      });
      assertEquals(
        await rpc.dispatch("frecency.list", { sessionID: parent.id }),
        frecency.list(oc.directory),
      );
      assertEquals(
        frecency.list(oc.directory)[0].path,
        join(oc.directory, "README.md"),
      );
      // Revert hides the parent task, so inspect its un-reverted sibling carrier.
      const carrier = await oc.request<Session>("/session", {
        method: "POST",
        body: { title: "Task carrier" },
      });
      const carried = await oc.request<{ info: Info; parts: RawPart[] }>(
        `/session/${carrier.id}/shell`,
        { method: "POST", body: { agent: "build", command: "printf carrier" } },
      );
      const carrierTool = carried.parts.find((part) => part.type === "tool")!;
      await oc.request(
        `/session/${carrier.id}/message/${carried.info.id}/part/${carrierTool.id}`,
        {
          method: "PATCH",
          body: {
            ...carrierTool,
            tool: "task",
            state: {
              ...carrierTool.state,
              input: {
                description: "Inspection",
                subagent_type: "general",
                prompt: "Inspect",
              },
              metadata: { sessionId: child.id },
            },
          },
        },
      );
      const before = reads.length;
      const messages = await adapter.core.listMessages(carrier.id, {
        limit: 20,
      });
      const task = messages.flatMap((message) => message.parts).find((part) =>
        part.kind === "tool" && part.call.tool === "task"
      );
      assert(task?.kind === "tool" && task.call.tool === "task");
      assertEquals(task.call.toolCount, tools.length);
      assert(task.call.currentTool?.startsWith("bash"));
      assert((task.call.duration ?? -1) >= 0);
      assertEquals(
        reads.slice(before).filter((url) =>
          url.pathname === `/session/${child.id}/message`
        ).length,
        mode === "SQL" ? 0 : 1,
      );
    }
    console.info("Stock metadata evidence:", oc.root);
  } finally {
    for (const adapter of adapters) await adapter.core.stop();
    store.close();
    await oc.stop();
    await fake.stop();
  }
});
