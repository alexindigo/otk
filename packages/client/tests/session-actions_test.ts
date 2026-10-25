// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import * as client from "@otk/client";
import type { PromptPart } from "@otk/protocol";
import {
  shellEntry,
  shellFixture,
  shellInfo,
  shellTask,
} from "./shell-fixture.ts";

Deno.test("session actions resolve directory from index then matching selected info then authoritative RPC", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  f.entries("local", [shellEntry("selected", "/index")]);
  assertEquals(actions.key(), "local/selected");
  assertEquals(actions.selectedEntry()?.directory, "/index");
  assertEquals(actions.info()?.directory, "/index");
  assertEquals(
    await actions.directory({ sidecarId: "local", sessionID: "selected" }),
    "/index",
  );
  f.entries("local", []);
  assertEquals(
    await actions.directory({ sidecarId: "local", sessionID: "selected" }),
    "/p",
  );
  assertEquals(f.calls, []);
  assertEquals(
    await actions.directory({ sidecarId: "remote", sessionID: "selected" }),
    "/resolved",
  );
  f.session.state.info = shellInfo("different");
  assertEquals(
    await actions.directory({ sidecarId: "local", sessionID: "selected" }),
    "/resolved",
  );
  f.session.state.selection = undefined;
  assertEquals(actions.key(), "");
  assertEquals(actions.selectedEntry(), undefined);
  assertEquals(f.calls.map((c) => c.slice(0, 2)), [["remote", "session.get"], [
    "local",
    "session.get",
  ]]);
  f.resources.stop();
});

Deno.test("session actions act uses its target directory and returns the successful action without promotion", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  assertEquals(
    await actions.act({ sidecarId: "remote", sessionID: "background" }, () => {
      f.calls.push(["action"]);
      return Promise.resolve(42);
    }),
    42,
  );
  assertEquals(f.calls, [
    ["remote", "session.get", { sessionID: "background" }],
    ["action"],
    ["remote", "projects.visit", { directory: "/resolved", active: true }],
  ]);
  f.resources.stop();
});

Deno.test("session rename captures the target server and uses act without promotion", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  const action = actions.rename({
    sidecarId: "remote",
    sessionID: "background",
  }, "New title");
  f.session.state.selection = { sidecarId: "local", sessionID: "different" };
  await action;
  assertEquals(f.calls, [
    ["remote", "session.get", { sessionID: "background" }],
    ["remote", "session.rename", {
      sessionID: "background",
      title: "New title",
    }],
    ["remote", "projects.visit", { directory: "/resolved", active: true }],
  ]);
  f.resources.stop();
});

Deno.test("session removal aborts a working captured target before delete and records one successful action", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  f.entries("remote", [{ ...shellEntry("busy", "/busy"), status: "busy" }]);
  await actions.remove({ sidecarId: "remote", sessionID: "busy" });
  assertEquals(f.calls, [
    ["remote", "session.abort", { sessionID: "busy" }],
    ["remote", "session.delete", { sessionID: "busy" }],
    ["remote", "projects.visit", { directory: "/busy", active: true }],
  ]);
  f.resources.stop();
});

Deno.test("session actions prompt captures invocation target and enters submission once with attachment ownership", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  f.entries("local", [shellEntry("selected")]);
  const held = Promise.withResolvers<unknown>();
  const admitted = Promise.withResolvers<void>();
  f.reply((_id, method) => {
    if (method === "tasks.create") {
      admitted.resolve();
      return held.promise;
    }
    return Promise.resolve(null);
  });
  const parts: PromptPart[] = [
    {
      kind: "file",
      source: "history",
      name: "foreign",
      mime: "text/plain",
      size: 1,
      sidecarID: "remote",
      messageID: "m",
      partID: "foreign",
    },
    {
      kind: "file",
      source: "history",
      name: "own",
      mime: "text/plain",
      size: 1,
      messageID: "m",
      partID: "own",
    },
    { kind: "text", text: "keep" },
  ];
  const sending = actions.prompt(parts, {
    agent: "plan",
    model: { provider: "p", model: "m" },
    variant: "high",
  });
  await admitted.promise;
  f.session.state.selection = { sidecarId: "remote", sessionID: "newer" };
  f.reply((_id, method, params) =>
    method === "history.attachment"
      ? Promise.resolve({
        kind: "text",
        text: `bytes:${(params as { partID: string }).partID}`,
      })
      : Promise.resolve(null)
  );
  held.resolve(shellTask("task", ["selected"]));
  await sending;
  assertEquals(f.calls, [
    ["local", "tasks.create", {
      directory: "/p",
      name: "selected",
      sessions: ["selected"],
    }],
    ["remote", "history.attachment", { messageID: "m", partID: "foreign" }],
    ["local", "history.attachment", { messageID: "m", partID: "own" }],
    ["local", "session.prompt", {
      sessionID: "selected",
      mode: "normal",
      parts: [
        { kind: "text", text: "bytes:foreign" },
        { kind: "text", text: "bytes:own" },
        { kind: "text", text: "keep" },
      ],
      agent: "plan",
      model: { provider: "p", model: "m" },
      variant: "high",
    }],
    ["local", "projects.visit", { directory: "/p", active: true }],
  ]);
  f.resources.stop();
});

Deno.test("session actions abort and replies use invocation-current act and never submit or promote", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  f.entries("local", [shellEntry("selected")]);
  f.entries("remote", [
    shellEntry("selected", "/remote"),
    shellEntry("background", "/background"),
  ]);
  await actions.abort();
  f.session.state.selection = { sidecarId: "remote", sessionID: "selected" };
  await actions.permission({
    sessionID: "selected",
    requestID: "p",
    reply: "once",
  });
  await actions.permission({
    sidecarId: "remote",
    sessionID: "background",
    requestID: "b",
    reply: "reject",
  });
  await actions.question({ requestID: "q", answers: [] });
  await actions.question({ requestID: "q" });
  assertEquals(f.calls, [
    ["local", "session.abort", { sessionID: "selected" }],
    ["local", "projects.visit", { directory: "/p", active: true }],
    ["remote", "permission.reply", {
      sessionID: "selected",
      requestID: "p",
      reply: "once",
    }],
    ["remote", "projects.visit", { directory: "/remote", active: true }],
    ["remote", "permission.reply", {
      sessionID: "background",
      requestID: "b",
      reply: "reject",
    }],
    ["remote", "projects.visit", { directory: "/background", active: true }],
    ["remote", "question.reply", { requestID: "q", answers: [] }],
    ["remote", "projects.visit", { directory: "/remote", active: true }],
    ["remote", "question.reject", { requestID: "q" }],
    ["remote", "projects.visit", { directory: "/remote", active: true }],
  ]);
  f.resources.stop();
});

Deno.test("session actions preserve root-only location and full-ancestry directory-scoped inTask", () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  f.entries("local", [
    shellEntry("root"),
    shellEntry("middle", "/p", "root"),
    shellEntry("leaf", "/p", "middle"),
  ]);
  const metadata = f.resources.inbox("local").state.inbox;
  metadata.tasks = [
    shellTask("middle-task", ["middle"]),
    shellTask("foreign-root", ["root"], "/other"),
  ];
  const target = { sidecarId: "local", sessionID: "leaf", rootID: "root" };
  assertEquals(
    actions.location(target, "leaf"),
    "p, foreign-root",
    "location deliberately ignores directory and middle ancestry",
  );
  assertEquals(
    actions.inTask(target),
    true,
    "inTask finds middle ancestry in the same directory",
  );
  metadata.tasks = [shellTask("foreign-root", ["root"], "/other")];
  assertEquals(actions.inTask(target), false);
  assertEquals(actions.location(target, "missing"), "foreign-root");
  metadata.tasks = [];
  assertEquals(actions.location(target, "leaf"), "p, leaf");
  assertEquals(actions.family({ ...target, rootID: "middle" }), target);
  f.session.state.selection = target;
  assertEquals(actions.child("unknown"), {
    sidecarId: "local",
    sessionID: "unknown",
    rootID: "root",
  });
  assertEquals(actions.child("middle"), {
    sidecarId: "local",
    sessionID: "middle",
  });
  f.resources.stop();
});
