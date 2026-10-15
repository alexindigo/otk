// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { type Capabilities, type Harness, HarnessError } from "@otk/harness";
import { createCurrentClient, Rpc, SidecarConnection } from "@otk/client";
import type { CurrentClient, Selection } from "@otk/client";
import { text } from "../../../core/ws/params.ts";
import {
  Frecency,
  frecencyMigrations,
  OtkDb,
  Prefs,
  prefsMigrations,
} from "@otk/store";
import {
  frecencyOptions,
  prefsOptions,
  registerAgents,
  registerCommands,
  registerFiles,
  registerFrecency,
  registerHistory,
  registerPermissions,
  registerPrefs,
  registerPrompt,
  registerQuestions,
  registerResources,
  registerRevert,
  registerSessions,
  registerShell,
  RpcRegistry,
} from "../../../core/mod.ts";
import { fixture } from "./support.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "external.directory": { params: Record<string, never>; result: string };
    "external.failure": { params: Record<string, never>; result: never };
    "extension.measure": {
      params: { sessionID: string; suffix: string };
      result: { directory: string; label: string };
    };
  }
}

const optional = [
  registerPrompt,
  registerShell,
  registerCommands,
  registerHistory,
  registerFiles,
  registerAgents,
  registerResources,
  registerPermissions,
  registerQuestions,
  registerRevert,
];

// Compile-only checks: features extend the public interface beside their code.
// Invalid calls are never invoked; runtime validation remains feature-owned.
export function typeContract(
  rpc: Rpc,
  current: CurrentClient,
  registry: RpcRegistry,
): void {
  const result: Promise<{ directory: string; label: string }> = rpc.call(
    "extension.measure",
    { sessionID: "s", suffix: "!" },
  );
  const selected: typeof result = current.call("extension.measure", {
    suffix: "!",
  });
  void selected;
  // @ts-expect-error Missing feature-owned parameter.
  rpc.call("extension.measure", { sessionID: "s" });
  // @ts-expect-error Incorrect feature-owned parameter type.
  current.call("extension.measure", { suffix: 1 });
  // @ts-expect-error Unknown method names are not a string escape hatch.
  rpc.call("extension.unknown", {});
  // @ts-expect-error Callers cannot supply an unrelated result type.
  rpc.call<number>("extension.measure", { sessionID: "s", suffix: "!" });
  // @ts-expect-error The result belongs to the method, not the caller.
  const wrong: Promise<number> = result;
  void wrong;
  registry.register("extension.measure", {
    params: () => undefined,
    // @ts-expect-error Server handlers must return the feature's declared result.
    handler: () => 1,
  });
  // @ts-expect-error Server registrations also reject undeclared names.
  registry.register("extension.unknown", {
    params: () => null,
    handler: () => null,
  });
}

Deno.test("feature-owned RPC augmentation reaches direct and invocation-time selected clients", async () => {
  const db = new OtkDb(await fixture(), []);
  const registry = new RpcRegistry(stub(), db);
  registry.register("extension.measure", {
    params: (p) => ({ id: text(p, "sessionID")!, suffix: text(p, "suffix")! }),
    handler: async (ctx, p) => ({
      directory: await ctx.sessionDirectory(p.id),
      label: p.id + p.suffix,
    }),
  });
  const connection = new SidecarConnection("http://127.0.0.1:1502", {
    status() {},
    frame() {},
  });
  connection.send = (frame) => {
    if (frame.t !== "rpc") return;
    void registry.dispatch(frame.method, frame.params).then((result) => {
      connection.rpc.receive(JSON.parse(JSON.stringify({
        t: "rpc.result",
        id: frame.id,
        ok: true,
        result,
      })));
    });
  };
  let selection: Selection = { sidecarId: "owned", sessionID: "first" };
  const current = createCurrentClient(() => selection, () => connection);
  try {
    assertEquals(
      await connection.rpc.call("extension.measure", {
        sessionID: "direct",
        suffix: "!",
      }),
      {
        directory: "/authoritative",
        label: "direct!",
      },
    );
    assertEquals(await current.call("extension.measure", { suffix: "!" }), {
      directory: "/authoritative",
      label: "first!",
    });
    selection = { sidecarId: "owned", sessionID: "second" };
    assertEquals(await current.call("extension.measure", { suffix: "?" }), {
      directory: "/authoritative",
      label: "second?",
    });
  } finally {
    connection.rpc.close();
    db.close();
  }
});
export function stub(
  capabilities: Capabilities = {},
  calls: unknown[] = [],
): Harness {
  const session = {
    id: "session",
    directory: "/authoritative",
    title: "Title",
    projectID: "project",
    time: { created: 1, updated: 2 },
    archived: false,
  };
  return {
    core: {
      kind: "stub",
      version: "1",
      start: async () => {},
      stop: async () => {},
      subscriptions() {},
      getSession: (id) => {
        calls.push(["get", id]);
        return Promise.resolve(session);
      },
      listChildren: (id) => {
        calls.push(["children", id]);
        return Promise.resolve([]);
      },
      listMessages: (id, opts) => {
        calls.push(["messages", id, opts]);
        return Promise.resolve([]);
      },
      createSession: (input) => {
        calls.push(["create", input]);
        return Promise.resolve({ ...session, ...input });
      },
    },
    capabilities,
  };
}

Deno.test("registry accepts external handlers with shared context, rejects duplicates and preserves error identity", async () => {
  const db = new OtkDb(await fixture(), []),
    harness = stub(),
    rpc = new RpcRegistry(harness, db);
  const failure = new HarnessError("owned", "Handler failure");
  try {
    rpc.register("external.directory", {
      params: () => "session",
      handler(ctx, id) {
        assertEquals(ctx.harness, harness);
        assertEquals(ctx.store, db);
        return ctx.sessionDirectory(id);
      },
    });
    assertEquals(
      await rpc.dispatch("external.directory", {}),
      "/authoritative",
    );
    assertThrows(
      () =>
        rpc.register("external.directory", {
          params: () => null,
          handler: () => "duplicate",
        }),
      HarnessError,
      "already registered",
    );
    rpc.register("external.failure", {
      params: () => null,
      handler() {
        throw failure;
      },
    });
    try {
      await rpc.dispatch("external.failure", {});
      throw new Error("Expected failure");
    } catch (error) {
      assertEquals(error, failure);
    }
    assertEquals(
      (await assertRejects(() => rpc.dispatch("unknown", []), HarnessError))
        .code,
      "params",
    );
    assertEquals(
      (await assertRejects(() => rpc.dispatch("unknown", {}), HarnessError))
        .code,
      "method",
    );
  } finally {
    db.close();
  }
});

Deno.test("each optional registration contributes only its present capability and core sessions stay usable", async () => {
  const db = new OtkDb(await fixture(), []);
  const names = [
    "prompt",
    "shell",
    "commands",
    "history",
    "files",
    "agents",
    "resources",
    "permissions",
    "questions",
    "revert",
  ] as const;
  const methods = [
    ["session.prompt", "session.abort"],
    ["session.shell"],
    ["commands.list", "session.command"],
    ["history.list", "history.attachment"],
    ["find.files"],
    ["agents.list"],
    ["resources.list"],
    ["permission.list", "permission.reply"],
    ["question.list", "question.reply", "question.reject"],
    ["session.revert"],
  ];
  try {
    const core = stub(), rpc = new RpcRegistry(core, db);
    for (const register of optional) register(rpc, core);
    assertEquals(rpc.methods(), []);
    registerSessions(rpc, core);
    assertEquals(
      await rpc.dispatch("session.get", { sessionID: "session" }),
      await core.core.getSession("session"),
    );
    for (const group of methods) {
      for (const method of group) {
        assertEquals(
          (await assertRejects(() => rpc.dispatch(method, {}), HarnessError))
            .code,
          "method",
        );
      }
    }
    for (const [index, name] of names.entries()) {
      // Registration tests existence, never invokes a capability until dispatch.
      const harness = stub({ [name]: {} }),
        registered = new RpcRegistry(harness, db);
      for (const register of optional) register(registered, harness);
      assertEquals(registered.methods(), methods[index]);
    }
  } finally {
    db.close();
  }
});

Deno.test("feature validators retain limits, optional strings, model/attachment, question and permission contracts", async () => {
  const calls: unknown[] = [],
    record = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve();
    };
  const harness = stub({
    prompt: {
      prompt: (input) => record("prompt", input),
      abort: (id) => record("abort", id),
    },
    shell: { shell: (input) => record("shell", input) },
    commands: {
      command: (input) => record("command", input),
      listCommands: () => Promise.resolve([]),
    },
    history: {
      listHistory: () => Promise.resolve([]),
      attachment: () =>
        Promise.resolve({
          kind: "file",
          source: "upload",
          name: "x",
          mime: "text/plain",
          dataBase64: "",
        }),
    },
    files: {
      findFiles: (id, query) => {
        calls.push(["files", id, query]);
        return Promise.resolve([]);
      },
    },
    agents: { listAgents: () => Promise.resolve([]) },
    resources: { listResources: () => Promise.resolve([]) },
    permissions: {
      listPermissions: () => Promise.resolve([]),
      replyPermission: (input) => record("permission", input),
    },
    questions: {
      listQuestions: () => Promise.resolve([]),
      answerQuestion: (id, answers) => record("question", id, answers),
    },
    revert: {
      revert: (id, message) => {
        calls.push(["revert", id, message]);
        return harness.core.getSession(id);
      },
    },
  }, calls);
  const db = new OtkDb(await fixture(), [
    prefsMigrations,
    frecencyMigrations,
  ]);
  const rpc = new RpcRegistry(harness, db);
  registerSessions(rpc, harness);
  for (const register of optional) register(rpc, harness);
  registerPrefs(rpc, harness, new Prefs(db, prefsOptions));
  registerFrecency(rpc, harness, new Frecency(db, frecencyOptions));
  try {
    const invalid: [string, unknown, string][] = [
      ["session.get", {}, "Expected sessionID string"],
      [
        "session.messages",
        { sessionID: "s", limit: 0 },
        "limit must be 1..200",
      ],
      [
        "session.messages",
        { sessionID: "s", limit: 201 },
        "limit must be 1..200",
      ],
      [
        "session.messages",
        { sessionID: "s", limit: 1.5 },
        "limit must be 1..200",
      ],
      ["session.create", { directory: "" }, "Expected directory string"],
      ["session.prompt", { parts: [] }, "parts required"],
      ["session.prompt", {
        parts: [{ kind: "text", text: "x" }],
        mode: "shell",
      }, "Expected normal prompt mode"],
      [
        "session.shell",
        { sessionID: "s", command: "x", model: [] },
        "Expected object",
      ],
      [
        "session.command",
        { parts: [{ kind: "text", text: "x" }] },
        "Commands accept file attachments only",
      ],
      [
        "question.reply",
        { requestID: "q", answers: [[1]] },
        "Expected question answer arrays",
      ],
      ["permission.reply", { reply: "invalid" }, "Invalid permission reply"],
      ["history.attachment", { messageID: "x" }, "Expected partID string"],
      [
        "prefs.set",
        { key: "unknown", value: true },
        "Invalid preference key or value",
      ],
    ];
    for (const [method, params, message] of invalid) {
      assertEquals(
        (await assertRejects(
          () => rpc.dispatch(method, params),
          HarnessError,
          message,
        )).code,
        "params",
      );
    }
    assertEquals(calls, []);
    await rpc.dispatch("session.messages", {
      sessionID: "s",
      limit: 200,
      before: "",
    });
    await rpc.dispatch("session.create", {
      directory: "/project",
      title: "",
      parentID: "",
    });
    const model = { provider: "p", model: "m" },
      parts = [{ kind: "text", text: "" }];
    assertEquals(
      await rpc.dispatch("session.prompt", {
        sessionID: "s",
        parts,
        mode: "normal",
        model,
        agent: "",
        variant: "",
      }),
      null,
    );
    assertEquals(
      await rpc.dispatch("session.shell", {
        sessionID: "s",
        command: "pwd",
        model,
      }),
      null,
    );
    assertEquals(
      await rpc.dispatch("session.command", {
        sessionID: "s",
        command: "test",
        parts: [],
        model,
      }),
      null,
    );
    assertEquals(await rpc.dispatch("find.files", { sessionID: "s" }), []);
    assertEquals(await rpc.dispatch("session.abort", { sessionID: "s" }), null);
    assertEquals(
      await rpc.dispatch("question.reply", {
        requestID: "q",
        answers: [[], ["one"]],
      }),
      null,
    );
    assertEquals(
      await rpc.dispatch("question.reject", { requestID: "q" }),
      null,
    );
    assertEquals(
      await rpc.dispatch("permission.reply", {
        sessionID: "s",
        requestID: "r",
        reply: "always",
        message: "",
      }),
      null,
    );
    assertEquals(calls, [
      ["messages", "s", { limit: 200, before: "" }],
      ["create", { directory: "/project", title: "", parentID: "" }],
      ["prompt", {
        sessionID: "s",
        parts,
        mode: "normal",
        model,
        agent: "",
        variant: "",
      }],
      ["shell", { sessionID: "s", command: "pwd", agent: undefined, model }],
      ["command", {
        sessionID: "s",
        command: "test",
        arguments: "",
        agent: undefined,
        variant: undefined,
        parts: [],
        model,
      }],
      ["files", "s", ""],
      ["abort", "s"],
      ["question", "q", [[], ["one"]]],
      ["question", "q", undefined],
      ["permission", {
        sessionID: "s",
        requestID: "r",
        reply: "always",
        message: "",
      }],
    ]);
  } finally {
    db.close();
  }
});
