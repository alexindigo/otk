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
    path.endsWith("/Shell.tsx") && source.includes("createTabs(") &&
    !/createTabs\([\s\S]*?\binput:\s*\(\)\s*=>\s*tabInput\(p\),\s*session:/
      .test(source)
  ) errors.push("shell tabs lack owner-current inputs and session resolution");
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
  return errors;
}
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
        "packages/ui/shell/Shell.tsx",
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
    new URL("packages/ui/shell/Shell.tsx", root),
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
