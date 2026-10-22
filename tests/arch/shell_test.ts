// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
const root = new URL("../../", import.meta.url);
function errors(path: string, source: string): string[] {
  const errors: string[] = [];
  if (
    path === "packages/ui/registries/shell.ts" &&
    /from\s+["'][^"']*(?:features|components|shell\/)/.test(source)
  ) errors.push("registry imports an implementation");
  if (
    path === "packages/ui/registries/prompt.ts" &&
    /\b(?:promptEnabled|shellEnabled|historyEnabled|agentsEnabled|commandsEnabled|pasteSummary|onAgents|onFind|onMentions|onBump|onCommands|onCommand|onNew|onHistory)\b/
      .test(source)
  ) errors.push("prompt owns feature-specific inputs");
  if (
    path.endsWith("/Shell.tsx") &&
    /<(?:PermissionDock|QuestionDock|Palette|KeysHelp|ThemePicker|Editor)\b|docks=/
      .test(source)
  ) errors.push("shell builds a registered feature");
  if (
    path === "web/src/ui/App.tsx" &&
    /create(?:Signal|Effect|Store)|\.rpc\.|new CommandHub/.test(source)
  ) errors.push("web owns shell behaviour");
  if (
    /^packages\/client\/(?:tabs|inbox)\.ts$/.test(path) &&
    /promote\s*[:(][^;{]*\bsession:\s*IndexEntry/.test(source)
  ) errors.push("tab promotion depends on a replicated status row");
  if (
    path === "packages/client/server-resources.ts" &&
    (!source.includes("createTabs(") ||
      !/createTabs\([\s\S]*?\binput:\s*\(\)\s*=>\s*tabInput\(p\),\s*session:/
        .test(source))
  ) errors.push("shell tabs lack owner-current inputs and session resolution");
  if (
    path.endsWith("/Shell.tsx") &&
    /createInbox\(|createApprovals\(|createTabs\(|\binboxes\b|\bapprovalModels\b|\btabModels\b|inboxProjects\(|rpc\.call\("(?:layout\.patch|projects\.inactive|prefs\.set)"/
      .test(source)
  ) errors.push("server resources belong to the client owner");
  if (
    path !== "packages/client/server-resources.ts" &&
    /\bfunction\s+createServerResources\s*\(/.test(source)
  ) errors.push("server resources have one client owner");
  if (
    path.startsWith("packages/ui/") &&
    /\.\.\.\s*layout\(\)|key:\s*["']shellLayout["']|onLayout\(\w+:\s*Preferences\["shellLayout"\]/
      .test(source)
  ) errors.push("layout controls must send field intents, not stale snapshots");
  if (
    path.endsWith("/RightPanel.tsx") &&
    /(?:from\s+["'][^"']*(?:features|ProjectSessions)|["']sessions["']|<ProjectSessions\b|rpc\.call)/
      .test(source)
  ) {
    errors.push("panel host owns a concrete view or its data");
  }
  if (path.endsWith("/Shell.tsx") && /\.supports\(/.test(source)) {
    errors.push(
      "shell feature availability bypasses reactive advertised state",
    );
  }
  if (
    path.endsWith("/ComposerTakeovers.tsx") &&
    /Permission|Question|\.permissions\(|\.questions\(/.test(source)
  ) {
    errors.push("takeover host selects concrete attention owners");
  }
  if (
    path.endsWith("/ToolFrame.tsx") &&
    /call\.tool\s*===|case\s+["'](?:edit|bash|task)["']/.test(source)
  ) {
    errors.push("tool frame owns feature presentation");
  }
  if (
    (path.endsWith("/Message.tsx") || path.endsWith("/work-log.ts")) &&
    /(?:part\.kind|case)\s*(?:===\s*)?["'](?:tool|reasoning)["']/.test(source)
  ) errors.push("work grouping belongs to contributed part presentation");
  if (
    path.startsWith("packages/ui/") &&
    /(?:interface|type)\s+Draft\s*[={]|new Map<string,\s*Draft>/.test(source)
  ) {
    errors.push("browser draft model belongs to client");
  }
  if (
    path.startsWith("packages/ui/") &&
    /function\s+(?:replyMessages|replyGroups|replyMetadata)\s*\(/.test(source)
  ) errors.push("reply projection belongs to client");
  if (
    path.endsWith("/Message.tsx") &&
    /fallback=\{[A-Za-z_$][\w$]*\([^}]*\.parts/.test(source)
  ) {
    errors.push(
      "part updates must flow through a stable keyed component, not a recreated JSX factory",
    );
  }
  return errors;
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
        "promote: (session: IndexEntry) => Promise<TaskRecord>",
      ],
      [
        "packages/client/inbox.ts",
        "promote(session: IndexEntry): Promise<TaskRecord>;",
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
  assert(
    owner.includes(
      'prefs.set("shellLayout", { ...prefs.get().shellLayout, ...patch })',
    ),
  );
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
  const scan = async (directory: string): Promise<void> => {
    for await (
      const file of Deno.readDir(
        new URL(
          directory.split("/").map(encodeURIComponent).join("/") + "/",
          root,
        ),
      )
    ) {
      const path = `${directory}/${file.name}`;
      if (file.isDirectory && file.name !== "tests") await scan(path);
      else if (file.isFile && /\.tsx?$/.test(path)) {
        assertEquals(
          errors(
            path,
            await Deno.readTextFile(
              new URL(path.split("/").map(encodeURIComponent).join("/"), root),
            ),
          ),
          [],
          path,
        );
      }
    }
  };
  await scan("packages");
  await scan("core");
  await scan("web/src");
  for (const path of ["main.ts", "application.ts"]) {
    assertEquals(
      errors(path, await Deno.readTextFile(new URL(path, root))),
      [],
      path,
    );
  }
});
