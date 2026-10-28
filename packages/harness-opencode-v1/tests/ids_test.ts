// SPDX-License-Identifier: LGPL-3.0-only
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OpencodeV1Adapter, opencodeV1SessionID as ids } from "../mod.ts";
import { isSessionID } from "@otk/protocol";
import { tempDir, test } from "../../../tests/support/resources.ts";
import { mapIndex, mapMessage, mapPermission, mapSession } from "../map.ts";
import { mapQuestion } from "../questions.ts";
import { mapTool } from "../map-tools.ts";
import type { RawPart } from "../types.ts";

Deno.test("native mappings qualify session references without changing message or request identities", () => {
  const raw = {
    id: "ses_child",
    parentID: "ses_parent",
    projectID: "project",
    directory: "/project",
    title: "Child",
    time: { created: 1, updated: 2 },
  };
  for (const mapped of [mapIndex(raw), mapSession(raw)]) {
    assertEquals(mapped.id, "opcv1-ses_child");
    assertEquals(mapped.parentID, "opcv1-ses_parent");
  }
  const message = mapMessage({
    id: "msg_reply",
    sessionID: "ses_child",
    parentID: "msg_prompt",
    role: "assistant",
    agent: "build",
    time: { created: 1 },
  });
  assertEquals(message.sessionID, "opcv1-ses_child");
  assertEquals(message.id, "msg_reply");
  assertEquals(message.role === "assistant" && message.replyTo, "msg_prompt");
  const permission = mapPermission({
    id: "per_request",
    sessionID: "ses_child",
    permission: "bash",
    patterns: ["ses_child"],
    always: [],
    metadata: { command: "ses_child" },
  });
  assertEquals(permission.sessionID, "opcv1-ses_child");
  assertEquals(permission.patterns, ["ses_child"]);
  assertEquals(permission.id, "per_request");
  assertEquals(
    mapQuestion({ id: "que_request", sessionID: "ses_child", questions: [] })
      .sessionID,
    "opcv1-ses_child",
  );
  const task = mapTool({
    id: "prt_task",
    sessionID: "ses_parent",
    messageID: "msg_reply",
    type: "tool",
    tool: "task",
    callID: "call_task",
    state: {
      status: "completed",
      input: {},
      metadata: { sessionId: "ses_child" },
    },
  } as RawPart);
  assertEquals(task.tool === "task" && task.childSessionID, "opcv1-ses_child");
});

Deno.test("one native codec derives identities, rejects invalid/foreign inputs and confines legacy conversion", () => {
  assertEquals(ids.encode("ses_A-1_z"), "opcv1-ses_A-1_z");
  assertEquals(ids.decode("opcv1-ses_A-1_z"), "ses_A-1_z");
  for (const value of ["", "ses_bad/id", "opcv1-ses_root", "clcv1-ses_root"]) {
    assertThrows(() => ids.encode(value));
  }
  for (
    const value of [
      "",
      "ses_root",
      "clcv1-ses_root",
      "opcv1-",
      "opcv1-ses_bad/id",
    ]
  ) assertThrows(() => ids.decode(value));
  for (const value of [null, 1, {}, "ses_root", "opcv1-", "opcv1-a/b"]) {
    assertEquals(isSessionID(value), false);
  }
  for (const value of ["opcv1-ses_root", "clcv20-native_1", "otkv1-a-b"]) {
    assertEquals(isSessionID(value), true);
  }
  assertEquals(ids.legacy("ses_root"), "opcv1-ses_root");
  assertEquals(ids.legacy("opcv1-ses_root"), "opcv1-ses_root");
  assertEquals(ids.legacy("clcv1-ses_root"), "clcv1-ses_root");
  assertEquals(ids.legacy("unknown legacy value"), "unknown legacy value");
});

Deno.test("identity grammars reject final line terminators and legacy retains unknown strings", () => {
  for (const end of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    const native = `ses_root${end}`, qualified = `opcv1-${native}`;
    assertEquals(isSessionID(qualified), false);
    assertThrows(() => ids.encode(native));
    assertThrows(() => ids.decode(qualified));
    assertEquals(ids.legacy(native), native);
  }
});

test("public adapter qualifies every capability boundary, including externally created helper and input requests", async () => {
  const root = {
    id: "ses_root",
    projectID: "p",
    directory: "/project",
    title: "Root",
    time: { created: 1, updated: 2 },
  };
  const child = {
    ...root,
    id: "ses_child",
    parentID: root.id,
    title: "External helper",
  };
  const permission = {
    id: "per_request",
    sessionID: child.id,
    permission: "bash",
    patterns: ["ses_root"],
    always: [],
    metadata: {},
  };
  const question = { id: "que_request", sessionID: child.id, questions: [] };
  const calls: { path: string; body: Record<string, unknown> | undefined }[] =
    [];
  const adapter = new OpencodeV1Adapter(
    {
      harness: {
        url: "http://native.invalid",
        db: (await tempDir("ids-")) + "/missing.db",
        username: "",
        password: "",
        heartbeattimeout: 25,
        reconnectmax: 30,
      },
      index: { days: 30 },
      messages: fixtureMessagePolicy,
    },
    undefined,
    (input, options) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        path,
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      });
      if (path === "/global/event") {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                  ),
                );
                options?.signal?.addEventListener(
                  "abort",
                  () => controller.close(),
                  { once: true },
                );
              },
            }),
          ),
        );
      }
      if (path === "/global/health") {
        return Promise.resolve(
          Response.json({ version: "1.18.34" }),
        );
      }
      if (path === "/experimental/session") {
        return Promise.resolve(
          Response.json([root, child]),
        );
      }
      if (path === "/session/status") {
        return Promise.resolve(
          Response.json({ [child.id]: { type: "busy" } }),
        );
      }
      if (path === "/permission") {
        return Promise.resolve(
          Response.json([permission]),
        );
      }
      if (path === "/question") {
        return Promise.resolve(Response.json([question]));
      }
      if (path === "/provider") {
        return Promise.resolve(
          Response.json({ connected: [], all: [] }),
        );
      }
      if (path === "/config") return Promise.resolve(Response.json({}));
      if (
        ["/agent", "/command", "/skill", "/mcp/resource", "/find/file"]
          .includes(path)
      ) return Promise.resolve(Response.json([]));
      if (path.endsWith("/children")) {
        return Promise.resolve(
          Response.json([child]),
        );
      }
      if (path.endsWith("/message")) {
        return Promise.resolve(
          Response.json([{
            info: {
              id: "msg_1",
              sessionID: child.id,
              role: "user",
              time: { created: 1 },
            },
            parts: [],
          }]),
        );
      }
      return Promise.resolve(
        Response.json(path === "/session/ses_child" ? child : root),
      );
    },
  );
  const ready = Promise.withResolvers<void>();
  let entries: import("@otk/protocol").SessionMetadata[] = [];
  try {
    await adapter.core.start({
      connection() {},
      indexReset(value) {
        entries = value;
        ready.resolve();
      },
      indexUpsert() {},
      indexRemove() {},
      content() {},
      resync() {},
    });
    await ready.promise;
    assertEquals(entries.map((entry) => [entry.id, entry.parentID]), [[
      "opcv1-ses_root",
      undefined,
    ], ["opcv1-ses_child", "opcv1-ses_root"]]);
    assertEquals(entries[1].status, "busy");
    const id = ids.encode(root.id), helper = ids.encode(child.id);
    assertEquals((await adapter.core.getSession(helper)).id, helper);
    assertEquals((await adapter.core.listChildren(id))[0].parentID, id);
    assertEquals(
      (await adapter.core.listMessages(helper, {})).items[0].sessionID,
      helper,
    );
    await adapter.core.createSession({ directory: "/project", parentID: id });
    assertEquals(
      calls.find((call) => call.path === "/session")!.body?.parentID,
      root.id,
    );
    const c = adapter.capabilities;
    assertEquals(
      (await c.permissions!.listPermissions(id))[0].sessionID,
      helper,
    );
    await c.permissions!.replyPermission({
      sessionID: helper,
      requestID: permission.id,
      reply: "once",
    });
    assertEquals((await c.questions!.listQuestions(id))[0].sessionID, helper);
    await c.questions!.answerQuestion(question.id, []);
    await c.agents!.listAgents(id);
    await c.models!.listModels(id);
    await c.commands!.listCommands(id);
    await c.resources!.listResources(id);
    await c.files!.findFiles(id, "file");
    await c.usage!.getUsage(id);
    await c.prompt!.prompt({
      sessionID: id,
      mode: "normal",
      parts: [{ kind: "text", text: "ses_root stays content" }],
    });
    await c.prompt!.abort(id);
    await c.shell!.shell({
      sessionID: id,
      command: "ses_root",
      agent: "build",
    });
    await c.commands!.command({
      sessionID: id,
      command: "probe",
      arguments: "ses_root",
    });
    await c.sessionActions!.rename(id, "ses_root is a title");
    await c.sessionActions!.fork(id);
    await c.sessionActions!.compact(id, {
      provider: "provider/id",
      model: "model/id",
    });
    await c.revert!.revert(id, "msg_boundary");
    await c.restore!.restore(id);
    await c.sessionActions!.remove(id);
    assertEquals(calls.some((call) => call.path.includes("opcv1-")), false);
    assertEquals(calls.find((call) => call.path.endsWith("/revert"))!.body, {
      messageID: "msg_boundary",
    });
    const before = calls.length;
    for (const bad of ["ses_root", "clcv1-ses_root", "opcv1-bad/id"]) {
      const reads = [
        () => adapter.core.getSession(bad),
        () => adapter.core.listChildren(bad),
        () => adapter.core.listMessages(bad, {}),
        () => c.agents!.listAgents(bad),
        () => c.models!.listModels(bad),
        () => c.resources!.listResources(bad),
        () => c.files!.findFiles(bad, ""),
        () => c.commands!.listCommands(bad),
        () => c.questions!.listQuestions(bad),
        () => c.usage!.getUsage(bad),
        () => c.prompt!.abort(bad),
        () => c.sessionActions!.rename(bad, "Title"),
        () => c.revert!.revert(bad, "msg_1"),
        () => c.restore!.restore(bad),
        () =>
          c.permissions!.replyPermission({
            sessionID: bad,
            requestID: "per_1",
            reply: "once",
          }),
      ];
      for (const read of reads) await assertRejects(read);
      assertThrows(() => c.permissions!.listPermissions(bad));
      assertThrows(() => adapter.core.subscriptions(bad, 1));
    }
    assertEquals(calls.length, before, "Invalid identities reached native I/O");
  } finally {
    await adapter.core.stop();
  }
});
