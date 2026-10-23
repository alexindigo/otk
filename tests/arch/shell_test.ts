// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { nodes, property } from "./syntax.ts";
import { shellPolicyErrors } from "./shell-policy.ts";
import { layoutBypasses, shellBypasses } from "./bypasses.ts";
layoutBypasses(layoutOwnerErrors);
shellBypasses((source) =>
  errors("packages/client/nested/duplicate.ts", source)
);
const root = new URL("../../", import.meta.url);
export function errors(path: string, source: string): string[] {
  return shellPolicyErrors(path, source);
}
export function layoutOwnerErrors(source: string): string[] {
  const parsed = new Source(source);
  const registrations = parsed.calls("register").filter((call) =>
    parsed.string(call.arguments[0]) === "layout.patch"
  );
  if (registrations.length !== 1) {
    return ["layout requires one registered handler"];
  }
  const options = parsed.value(registrations[0].arguments[1]);
  const field = options?.type === "ObjectExpression"
    ? options.properties.find((p) =>
      p.type === "ObjectProperty" && property(p.key) === "handler"
    )
    : undefined;
  const handler = field?.type === "ObjectProperty"
    ? parsed.value(field.value)
    : undefined;
  const error = ["layout handler merges and saves the authoritative value"];
  if (
    handler?.type !== "ArrowFunctionExpression" &&
    handler?.type !== "FunctionExpression"
  ) return error;
  if (
    handler.async ||
    [...nodes(handler.body)].some((node) => node.type === "AwaitExpression")
  ) return error;
  const patch = handler.params[1];
  const outputs = handler.body.type === "BlockStatement"
    ? [...nodes(handler.body)].flatMap((node) =>
      node.type === "ReturnStatement" && node.argument ? [node.argument] : []
    )
    : [handler.body];
  if (outputs.length !== 1) return error;
  const call = parsed.value(outputs[0]);
  if (
    call?.type !== "CallExpression" ||
    !parsed.name(call.callee)?.endsWith(".set") ||
    parsed.string(call.arguments[0]) !== "shellLayout"
  ) return error;
  const value = parsed.value(call.arguments[1]);
  if (
    value?.type !== "ObjectExpression" || value.properties.length !== 2 ||
    value.properties.some((p) => p.type !== "SpreadElement")
  ) return error;
  const [current, intent] = value.properties;
  if (current.type !== "SpreadElement" || intent.type !== "SpreadElement") {
    return error;
  }
  return parsed.name(current.argument) ===
        parsed.name(call.callee)?.replace(/\.set$/, ".get.shellLayout") &&
      parsed.name(intent.argument) === (patch && parsed.name(patch))
    ? []
    : error;
}
Deno.test("composer and tool hosts remain open while client owns browser drafts", async () => {
  for (
    const path of [
      "packages/ui/components/ComposerTakeovers.tsx",
      "packages/ui/components/tools/ToolFrame.tsx",
      "packages/ui/components/Message.tsx",
      "packages/ui/components/work-log.ts",
      "packages/ui/components/prompt/model.ts",
      "packages/ui/shell/Shell.tsx",
    ]
  ) {
    assertEquals(
      errors(path, await Deno.readTextFile(new URL(path, root))),
      [],
      path,
    );
  }
  for (
    const [path, source] of [
      [
        "packages/ui/components/ComposerTakeovers.tsx",
        "session.permissions().length || session.questions().length",
      ],
      ["packages/ui/components/tools/ToolFrame.tsx", 'call.tool === "edit"'],
      ["packages/ui/components/Message.tsx", 'part.kind === "tool"'],
      [
        "packages/ui/components/prompt/model.ts",
        "interface Draft { input: string }",
      ],
      ["packages/ui/shell/Shell.tsx", "new Map<string, Draft>()"],
      [
        "packages/ui/components/Message.tsx",
        "fallback={renderParts(group().parts)}",
      ],
      [
        "packages/ui/components/Message.tsx",
        "function replyMessages(messages) {}",
      ],
    ]
  ) assert(errors(path, source).length > 0, source);
});
Deno.test("shell registries stay open, implementation-free and feature ports replace per-feature prompt wiring", async () => {
  for (
    const path of [
      "packages/ui/registries/shell.ts",
      "packages/ui/registries/prompt.ts",
      "packages/ui/shell/Shell.tsx",
      "packages/ui/components/RightPanel.tsx",
      "web/src/ui/App.tsx",
    ]
  ) {
    assertEquals(
      errors(path, await Deno.readTextFile(new URL(path, root))),
      [],
      path,
    );
  }
  for (
    const [path, source] of [
      [
        "packages/ui/registries/shell.ts",
        'import Palette from "../components/Palette.tsx";',
      ],
      ["packages/ui/registries/prompt.ts", "onMentions(): void;"],
      ["packages/ui/registries/prompt.ts", "shellEnabled?: boolean;"],
      ["packages/ui/shell/Shell.tsx", "const feature = <PermissionDock />;"],
      ["web/src/ui/App.tsx", "const state = createSignal(false);"],
      [
        "packages/ui/components/RightPanel.tsx",
        'import ProjectSessions from "./ProjectSessions.tsx";',
      ],
      ["packages/ui/components/RightPanel.tsx", 'const view = "sessions";'],
    ]
  ) assert(errors(path, source).length > 0, source);
  const session = await Deno.readTextFile(
    new URL("packages/ui/registries/session.tsx", root),
  );
  assert(session.includes('rpc: InboxRpc["call"]'));
  assert(session.includes("supports(capability: CapabilityName)"));
  const features = await Deno.readTextFile(
    new URL("web/src/features.ts", root),
  );
  for (
    const owner of [
      "registerPermissionTakeover",
      "registerQuestionTakeover",
      "registerCommandDialogs",
      "registerProjectDialogs",
      "registerEditorDialog",
      "registerSessionsPanel",
    ]
  ) assert(features.includes(owner));
});

Deno.test("tab commands own readiness and the shell injects current inputs and authoritative metadata", async () => {
  for (
    const path of [
      "packages/client/tabs.ts",
      "packages/client/inbox.ts",
      "packages/client/server-resources.ts",
      "packages/ui/shell/Shell.tsx",
    ]
  ) {
    assertEquals(
      errors(path, await Deno.readTextFile(new URL(path, root))),
      [],
      path,
    );
  }
  for (
    const [path, source] of [
      [
        "packages/client/tabs.ts",
        "interface Tabs { promote: (session: IndexEntry) => Promise<TaskRecord>; }",
      ],
      [
        "packages/client/inbox.ts",
        "interface Inbox { promote(session: IndexEntry): Promise<TaskRecord>; }",
      ],
      [
        "packages/client/server-resources.ts",
        "createTabs(inbox(p.sidecarId).promote, solidState);",
      ],
    ]
  ) assert(errors(path, source).length > 0, source);
});

Deno.test("layout controls send field intents to the authoritative persistence owner", async () => {
  for (
    const path of [
      "packages/ui/shell/Shell.tsx",
      "packages/ui/components/ProjectInbox.tsx",
      "packages/ui/components/RightPanel.tsx",
    ]
  ) {
    assertEquals(
      errors(path, await Deno.readTextFile(new URL(path, root))),
      [],
    );
    for (
      const source of [
        "save({ ...layout(), leftWidth: next });",
        'rpc.call("prefs.set", { key: "shellLayout", value });',
        'onLayout(layout: Preferences["shellLayout"]): Promise<void>;',
      ]
    ) assert(errors(path, source).length > 0, source);
  }
  const shell = await Deno.readTextFile(
    new URL("packages/client/server-resources.ts", root),
  );
  assert(shell.includes('rpc.call("layout.patch", patch)'));
  const owner = await Deno.readTextFile(
    new URL("core/features/layout.ts", root),
  );
  assertEquals(layoutOwnerErrors(owner), []);
  assert(!/\basync\b|\bawait\b/.test(owner.replace(/\/\/[^\n]*/g, "")));
});

Deno.test("shell feature ports observe advertised state rather than transport-private capability checks", async () => {
  const path = "packages/ui/shell/Shell.tsx";
  assertEquals(errors(path, await Deno.readTextFile(new URL(path, root))), []);
  for (
    const source of [
      "supports: (capability) => connection.supports(capability)",
      "supports: (capability) => sidecars.connection(id).supports(capability)",
    ]
  ) assert(errors(path, source).length > 0, source);
});

Deno.test("shell delegates server resources to one framework-free owner", async () => {
  const shell = "packages/ui/shell/Shell.tsx";
  assertEquals(
    errors(shell, await Deno.readTextFile(new URL(shell, root))),
    [],
  );
  for (
    const source of [
      "createInbox(rpc)",
      "createApprovals(rpc)",
      "createTabs(promote)",
      "const inboxes = cache",
      "const approvalModels = cache",
      "const tabModels = cache",
      "inboxProjects(entries)",
      'rpc.call("layout.patch", patch)',
      'rpc.call("projects.inactive", input)',
      'rpc.call("prefs.set", input)',
      "function createServerResources(options) {}",
    ]
  ) assert(errors(shell, source).length > 0, source);
  assertEquals(errors(shell, 'commands.run("prefs.set", input)'), []);
  assert(
    errors(
      "packages/client/duplicate.ts",
      "function createServerResources(options) {}",
    ).length > 0,
  );
  for (const [path, source] of await productionSources()) {
    if (!path.endsWith(".css")) assertEquals(errors(path, source), [], path);
  }
});

Deno.test("shell delegates session operations and ports without private capability or RPC bypasses", async () => {
  for (
    const path of [
      "packages/ui/shell/Shell.tsx",
      "packages/ui/shell/session-ports.ts",
    ]
  ) {
    assertEquals(
      errors(path, await Deno.readTextFile(new URL(path, root))),
      [],
      path,
    );
  }
  for (
    const source of [
      "createSessionSubmission(options)",
      "sessionAncestors(id)",
      'rpc.call("session.prompt", p)',
      'rpc.call("session.abort", p)',
      'rpc.call("history.attachment", p)',
      "inbox.tasks.find(predicate)",
      "inbox.tasks.some(predicate)",
      "function sessionPorts() {}",
      "const sessionPorts = factory",
      "function createSessionActions(o) {}",
      "function directoryFor(t) {}",
    ]
  ) {
    assert(errors("packages/ui/shell/Shell.tsx", source).length > 0, source);
  }
  for (
    const path of [
      "packages/ui/shell/session-ports.ts",
      "packages/ui/state/shell.ts",
    ]
  ) {
    for (
      const source of [
        'connection.rpc.call("models.list", p)',
        "new Map<string, unknown>()",
        "connection.supports(capability)",
      ]
    ) {
      assert(errors(path, source).length > 0, source);
    }
  }
  assert(
    errors(
      "packages/client/duplicate.ts",
      "function createSessionActions(o) {}",
    ).length > 0,
  );
});

Deno.test("shell binds guarded navigation without browser policy, transactions or caches", async () => {
  for (
    const path of ["packages/ui/shell/Shell.tsx", "packages/ui/state/shell.ts"]
  ) {
    assertEquals(
      errors(path, await Deno.readTextFile(new URL(path, root))),
      [],
      path,
    );
  }
  for (
    const source of [
      'connection.rpc.call("session.create", input)',
      "new Map<string, boolean>()",
      "createTaskActions(rpc, path)",
      "createNavigation(options)",
      "route(hash)",
      "projectRoute(hash)",
      "hashFor(target)",
      "projectHash(project)",
      "globalThis.confirm(message)",
      "navigationRevision++",
      "document.hasFocus()",
      "function applyRoute(hash) {}",
      "function discardDraft() {}",
      "function createInputGuard(o) {}",
      "function createShellNavigation(o) {}",
    ]
  ) {
    assert(errors("packages/ui/shell/Shell.tsx", source).length > 0, source);
  }
  for (const name of ["createInputGuard", "createShellNavigation"]) {
    assert(
      errors("packages/client/duplicate.ts", `function ${name}(o) {}`).length >
        0,
    );
  }
});

Deno.test("A12 layout contract accepts renamed parameters, const aliases and comments", () => {
  assertEquals(
    layoutOwnerErrors(`
    export function install(dispatch, preferences) {
      const bus = dispatch, store = preferences;
      bus.register("layout.patch", {
        handler: (_context, fields) => {
          const latest = store.get().shellLayout;
          // The registered handler owns the authoritative merge.
          const merged = { ...latest, ...fields };
          return store.set("shellLayout", merged);
        }
      });
    }
  `),
    [],
  );
});
