// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import * as client from "@otk/client";
import type { PromptPart } from "@otk/protocol";
import {
  shellEntry,
  shellFixture,
  shellInfo,
  shellTask,
} from "./shell-fixture.ts";

Deno.test("revert RPC never starts capture; preservation still precedes every shared submission and Compact", async () => {
  const f = shellFixture(), events: string[] = [];
  const actions = client.createSessionActions({
    ...f,
    branchHistory: {
      prepare: () => {
        events.push("save-branch");
        return Promise.resolve();
      },
      beforeCommit: () => {
        events.push("save-draft");
        return Promise.resolve();
      },
      settled: () => {
        events.push("settle");
        return Promise.resolve();
      },
    },
  });
  const compactEntered = Promise.withResolvers<void>();
  const compactResponse = Promise.withResolvers<null>();
  f.reply((_server, method) => {
    events.push(method);
    if (method === "session.compact") {
      compactEntered.resolve();
      return compactResponse.promise;
    }
    if (method === "tasks.create") {
      return Promise.resolve(shellTask("promoted", ["selected"]));
    }
    if (method === "session.get") return Promise.resolve(shellInfo("selected"));
    return Promise.resolve(
      method === "session.revert"
        ? {
          ...shellInfo("selected"),
          revert: {
            boundaryID: "boundary",
            messageIDs: ["boundary"],
            files: [],
          },
        }
        : null,
    );
  });
  const target = { sidecarId: "local", sessionID: "selected" };
  await actions.revert(target, "boundary");
  assertEquals(events.includes("save-branch"), false);
  assertEquals(events[0], "session.revert");
  events.length = 0;
  const compact = actions.compact(target, { provider: "p", model: "m" });
  await compactEntered.promise;
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assertEquals(events.includes("settle"), false);
  compactResponse.resolve(null);
  await compact;
  assertEquals(events.slice(0, 3), ["save-draft", "session.compact", "settle"]);
  events.length = 0;
  await actions.submission(target)(() => {
    events.push("mode-specific-send");
    return Promise.resolve();
  });
  assertEquals(
    events.filter((e) =>
      ["save-draft", "mode-specific-send", "settle"].includes(e)
    ),
    ["save-draft", "mode-specific-send", "settle"],
  );
  f.resources.stop();
});

Deno.test("failed branch preservation prevents native send and Compact", async () => {
  const f = shellFixture();
  const actions = client.createSessionActions({
    ...f,
    branchHistory: {
      prepare: () => Promise.reject(new Error("storage-full")),
      beforeCommit: () => Promise.reject(new Error("storage-full")),
      settled: () => Promise.resolve(),
    },
  });
  const target = { sidecarId: "local", sessionID: "selected" };
  f.reply((_server, method) =>
    Promise.resolve(
      method === "session.revert"
        ? {
          ...shellInfo("selected"),
          revert: {
            boundaryID: "boundary",
            messageIDs: ["boundary"],
            files: [],
          },
        }
        : null,
    )
  );
  await actions.revert(target, "boundary");
  await assertRejects(
    () => actions.compact(target, { provider: "p", model: "m" }),
    Error,
    "storage-full",
  );
  await assertRejects(
    () =>
      actions.submission(target)(() => {
        throw new Error("native must not run");
      }),
    Error,
    "storage-full",
  );
  assertEquals(
    f.calls.filter((c) =>
      ["session.compact", "session.prompt"].includes(
        String(c[1]),
      )
    ),
    [],
  );
  f.resources.stop();
});

Deno.test("a permanence choice waits before pending-send publication and captures its original target", async () => {
  const f = shellFixture(),
    target = { sidecarId: "local", sessionID: "selected" };
  f.entries("local", [shellEntry("selected")]);
  const entered = Promise.withResolvers<void>(),
    choice = Promise.withResolvers<client.BranchSendPermit>();
  f.reply((_id, method) =>
    Promise.resolve(
      method === "tasks.create" ? shellTask("task", ["selected"]) : null,
    )
  );
  const actions = client.createSessionActions({
    ...f,
    branchHistory: {
      prepare: () => Promise.resolve(),
      settled: () => Promise.resolve(),
      beforeCommit: () => Promise.resolve(),
      beforeSend: () => {
        entered.resolve();
        return choice.promise;
      },
    },
  });
  const sending = actions.prompt([{
    kind: "text",
    text: "Captured invocation",
  }], {});
  await entered.promise;
  assertEquals(actions.delivery(target).state.receipts, []);
  assertEquals(f.calls.some((call) => call[1] === "session.prompt"), false);
  f.session.state.selection = { sidecarId: "local", sessionID: "other" };
  choice.resolve({ target });
  await sending;
  const call = f.calls.find((call) => call[1] === "session.prompt")!;
  assertEquals((call[2] as { sessionID: string }).sessionID, "selected");
  actions.stop();
  f.resources.stop();
});

for (const kind of ["revert", "restore"] as const) {
  Deno.test(`Send preservation waits for the captured ${kind} mutation`, async () => {
    const f = shellFixture();
    const target = { sidecarId: "local", sessionID: "selected" };
    f.entries("local", [shellEntry("selected")]);
    const entered = Promise.withResolvers<void>();
    const native = Promise.withResolvers<ReturnType<typeof shellInfo>>();
    let preserving = false;
    f.reply((_id, method) => {
      if (method === `session.${kind}`) {
        entered.resolve();
        return native.promise;
      }
      return Promise.resolve(
        method === "tasks.create" ? shellTask("task", ["selected"]) : null,
      );
    });
    const actions = client.createSessionActions({
      ...f,
      branchHistory: {
        prepare: () => Promise.resolve(),
        settled: () => Promise.resolve(),
        beforeCommit: () => Promise.resolve(),
        beforeSend: () => {
          preserving = true;
          return Promise.resolve({ target });
        },
      },
    });
    const changing = kind === "revert"
      ? actions.revert(target, "boundary")
      : actions.restore(target);
    await entered.promise;
    const sending = actions.prompt([{ kind: "text", text: "Replacement" }], {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeSettlement = preserving;
    const receipts = [...actions.delivery(target).state.receipts];
    native.resolve(shellInfo("selected"));
    await changing;
    await sending;
    assertEquals(preserving, true);
    actions.stop();
    f.resources.stop();
    assertEquals(beforeSettlement, false);
    assertEquals(receipts, []);
  });
}

Deno.test("Send joins the revert owner's publication wait before checking preservation", async () => {
  const f = shellFixture(),
    target = { sidecarId: "local", sessionID: "selected" };
  f.entries("local", [shellEntry("selected")]);
  const ready = Promise.withResolvers<void>();
  let preserving = false;
  const actions = client.createSessionActions({
    ...f,
    revertReady: () => ready.promise,
    branchHistory: {
      prepare: () => Promise.resolve(),
      settled: () => Promise.resolve(),
      beforeCommit: () => Promise.resolve(),
      beforeSend: () => {
        preserving = true;
        return Promise.resolve({ target });
      },
    },
  });
  f.reply((_id, method) =>
    Promise.resolve(
      method === "tasks.create" ? shellTask("task", ["selected"]) : null,
    )
  );
  const sending = actions.prompt([{ kind: "text", text: "Replacement" }], {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const admittedEarly = preserving;
  ready.resolve();
  await sending;
  actions.stop();
  f.resources.stop();
  assertEquals(admittedEarly, false);
  assertEquals(preserving, true);
});

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

Deno.test("non-phantom session rename captures the target server and uses act without promotion", async () => {
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

Deno.test("renaming a phantom promotes once with the captured new name and retains idle seen membership after reload", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  const root = { ...shellEntry("renamed"), status: "busy" as const };
  f.entries("local", [root, shellEntry("other")]);
  const project = { sidecarId: "local", directory: "/p" };
  const tabs = f.resources.tabs(project);
  tabs.preview(root.id);
  const held = Promise.withResolvers<unknown>();
  const entered = Promise.withResolvers<void>();
  f.reply((_server, method, params) => {
    if (method === "session.rename") {
      entered.resolve();
      return held.promise;
    }
    if (method === "tasks.create") {
      return Promise.resolve({
        ...shellTask("persisted", [root.id]),
        name: (params as { name: string }).name,
      });
    }
    return Promise.resolve(null);
  });
  const renaming = actions.rename(
    { sidecarId: "local", sessionID: root.id },
    "New task name",
  );
  await entered.promise;
  tabs.preview("other");
  held.resolve({ ...shellInfo(root.id), title: "New task name" });
  await renaming;
  assertEquals(f.calls.filter((call) => call[1] === "tasks.create"), [[
    "local",
    "tasks.create",
    { directory: "/p", name: "New task name", sessions: [root.id] },
  ]]);
  assertEquals(tabs.state.sessionID, "other");
  const restored = client.createTabs(() => {
    throw Error("No further promotion");
  });
  restored.update({
    directory: "/p",
    entries: [{ ...root, status: "idle" }],
    inbox: {
      projects: [],
      tasks: [{ ...shellTask("persisted", [root.id]), name: "New task name" }],
      seen: { [root.id]: 20 },
      finishes: { [root.id]: 20 },
      pathTemplates: [],
    },
  });
  assertEquals(
    restored.tabs().map((tab) => [tab.kind, tab.title, tab.status]),
    [["task", "New task name", "none"]],
  );
  restored.stop();
  f.resources.stop();
});

Deno.test("session fork captures its target and inclusive boundary without promoting the original", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  const action = actions.fork(
    { sidecarId: "remote", sessionID: "background" },
    "last-step",
  );
  f.session.state.selection = { sidecarId: "local", sessionID: "newer" };
  await action;
  assertEquals(f.calls, [
    ["remote", "session.get", { sessionID: "background" }],
    ["remote", "session.fork", {
      sessionID: "background",
      through: "last-step",
    }],
    ["remote", "projects.visit", { directory: "/resolved", active: true }],
  ]);
  f.resources.stop();
});

Deno.test("session compact captures its target and next-prompt model inside act without promotion", async () => {
  const f = shellFixture(), actions = client.createSessionActions(f);
  const pending = actions.compact({
    sidecarId: "remote",
    sessionID: "background",
  }, { provider: "chosen", model: "model" });
  f.session.state.selection = { sidecarId: "local", sessionID: "newer" };
  await pending;
  assertEquals(f.calls, [
    ["remote", "session.get", { sessionID: "background" }],
    ["remote", "session.compact", {
      sessionID: "background",
      model: { provider: "chosen", model: "model" },
    }],
    ["remote", "projects.visit", { directory: "/resolved", active: true }],
  ]);
  f.resources.stop();
});

Deno.test("revert and restore capture target RPCs inside act without promotion", async () => {
  for (const method of ["revert", "restore"] as const) {
    const f = shellFixture(), actions = client.createSessionActions(f);
    f.reply((_server, rpc) =>
      Promise.resolve(
        rpc === "session.get"
          ? shellInfo("background", "/resolved")
          : rpc === `session.${method}`
          ? shellInfo("background", "/resolved")
          : null,
      )
    );
    const target = { sidecarId: "remote", sessionID: "background" };
    const pending = method === "revert"
      ? actions.revert(target, "boundary")
      : actions.restore(target);
    f.session.state.selection = { sidecarId: "local", sessionID: "newer" };
    await pending;
    assertEquals(f.calls, [
      ["remote", "session.get", { sessionID: "background" }],
      ["remote", `session.${method}`, {
        sessionID: "background",
        ...(method === "revert" ? { messageID: "boundary" } : {}),
      }],
      ["remote", "projects.visit", { directory: "/resolved", active: true }],
    ]);
    f.resources.stop();
  }
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
  const captured =
    actions.delivery({ sidecarId: "local", sessionID: "selected" }).state
      .receipts[0];
  assertMatch(captured.messageID!, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  await admitted.promise;
  f.session.state.selection = { sidecarId: "remote", sessionID: "newer" };
  f.reply((_id, method, params) =>
    method === "history.attachments"
      ? Promise.resolve({
        items: (params as { refs: { messageID: string; partID: string }[] })
          .refs.map((ref) => ({
            ref,
            part: {
              kind: "file",
              source: "upload",
              name: ref.partID,
              mime: "text/plain",
              dataBase64: btoa(`bytes:${ref.partID}`),
            },
          })),
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
    ["remote", "history.attachments", {
      refs: [{ messageID: "m", partID: "foreign" }],
    }],
    ["local", "history.attachments", {
      refs: [{ messageID: "m", partID: "own" }],
    }],
    ["local", "session.prompt", {
      sessionID: "selected",
      messageID: captured.messageID,
      mode: "normal",
      parts: [
        {
          kind: "file",
          source: "upload",
          name: "foreign",
          mime: "text/plain",
          dataBase64: btoa("bytes:foreign"),
        },
        {
          kind: "file",
          source: "upload",
          name: "own",
          mime: "text/plain",
          dataBase64: btoa("bytes:own"),
        },
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
