// SPDX-License-Identifier: LGPL-3.0-only
import { cfg } from "../support/config.ts";
import { fixtureMessagePolicy } from "../support/message-pages.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests("V1 WAL message/part scalar SQL and revert body", [
  "tests/integration/v2-transcripts_test.ts#OC2T2",
  "tests/integration/v2-catalogs_test.ts#OC2C2",
]);
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type Info,
  OpencodeV1Adapter as Opencode1Adapter,
  type RawPart,
  type Session,
} from "@otk/harness-opencode-v1";
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
  const store = new OtkDb(join(oc.root, "otk"), [frecencyMigrations], {
    busyms: 5000,
  });
  try {
    const parent = await oc.session<Session>("/session", {
      method: "POST",
      body: { title: "Bounded parent" },
    });
    const child = await oc.session<Session>("/session", {
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
            metadata: { sessionId: child.nativeID },
          },
        },
      },
    );
    // Native revert stages three user rows at/after the boundary: two prompts
    // and the user's shell run, whose user row carries only synthetic text.
    const staged = (await oc.request<{ info: Info; parts: RawPart[] }[]>(
      `/session/${parent.id}/message?limit=200`,
    )).filter((m) => m.info.role === "user" && m.info.id >= users[1]);
    assertEquals(staged.length, 3);
    const shellUser = staged.find((m) => m.info.id === shell.info.parentID)!;
    assert(shellUser.parts.length > 0);
    assert(
      shellUser.parts.every((p) => p.type === "text" && p.synthetic === true),
    );
    await oc.request(`/session/${parent.id}/revert`, {
      method: "POST",
      body: { messageID: users[1] },
    });
    const reads: URL[] = [];
    for (const mode of ["SQL", "API"]) {
      const adapter = new Opencode1Adapter(
        {
          ...cfg(),
          harness: {
            url: oc.url,
            username: "opencode",
            password: "",
            db: mode === "SQL" ? oc.db : join(oc.root, "missing.db"),
            heartbeattimeout: 25,
            reconnectmax: 30,
            requestms: 60000,
          },
          index: { days: 30 },
          messages: fixtureMessagePolicy,
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
      // The strip counts rolled-back prompts. Content-proven prompt identity
      // (NT4; plan 3.1: context never anchors a revert count) excludes the
      // synthetic-only shell row, as V2 counts only `user` prompts, never
      // `shell` records. SQL and the bounded API fallback agree.
      const revert = (await adapter.core.getSession(parent.id)).revert;
      assertEquals(revert?.messageCount, 2);
      assertEquals(revert?.prompts?.map((p) => p.messageID), users.slice(1));
      const frecency = new Frecency(store, frecencyOptions);
      const rpc = new RpcRegistry(adapter, store);
      registerFrecency(rpc, adapter, frecency);
      await rpc.dispatch("frecency.bump", {
        sessionID: parent.id,
        directory: "/forged",
        path: "README.md",
      });
      assertEquals(
        (await rpc.dispatch("frecency.list", { sessionID: parent.id }) as {
          entries: ReturnType<typeof frecency.list>;
        }).entries,
        frecency.list(oc.directory),
      );
      assertEquals(
        frecency.list(oc.directory)[0].path,
        join(oc.directory, "README.md"),
      );
      // Revert hides the parent task, so inspect its un-reverted sibling carrier.
      const carrier = await oc.session<Session>("/session", {
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
              metadata: { sessionId: child.nativeID },
            },
          },
        },
      );
      const before = reads.length;
      const { items: messages } = await adapter.core.listMessages(
        carrier.id,
        {},
      );
      const task = messages.flatMap((message) => message.parts).find((part) =>
        part.kind === "tool" && part.call.tool === "task"
      );
      assert(task?.kind === "tool" && task.call.tool === "task");
      assertEquals(task.call.progress, {
        state: "unavailable",
        revision: 0,
        progress: { state: "unavailable" },
      });
      assertEquals(
        reads.slice(before).filter((url) =>
          url.pathname === `/session/${child.nativeID}/message`
        ).length,
        0,
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
