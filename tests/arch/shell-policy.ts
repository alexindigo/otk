// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { nodes, property } from "./syntax.ts";

export function shellPolicyErrors(path: string, text: string): string[] {
  const errors = new Set<string>();
  let source: Source;
  try {
    source = new Source(text, path);
  } catch {
    return ["shell source must parse"];
  }
  const ui = path.startsWith("packages/ui/");
  const shell = path.endsWith("/Shell.tsx");
  const binding = /^packages\/ui\/(?:shell\/session-ports|state\/shell)\.ts$/
    .test(path);
  const owners: Record<string, string> = {
    createServerResources: "server-resources",
    createSessionActions: "session-actions",
    createInputGuard: "input-guard",
    createShellNavigation: "shell-navigation",
  };
  const report = (message: string) => errors.add(message);
  for (const node of source.all) {
    const defined = node.type === "FunctionDeclaration"
      ? node.id?.name
      : node.type === "VariableDeclarator" &&
          ["ArrowFunctionExpression", "FunctionExpression"].includes(
            node.init?.type ?? "",
          )
      ? property(node.id)
      : undefined;
    if (
      defined && owners[defined] &&
      path !== `packages/client/${owners[defined]}.ts`
    ) report("client resources and transactions have one framework-free owner");
    if (
      shell &&
      (defined === "sessionPorts" ||
        node.type === "VariableDeclarator" &&
          property(node.id) === "sessionPorts")
    ) report("session target operations belong to the client owner");
    if (
      ui && defined &&
      [
        "applyRoute",
        "discardDraft",
        "directoryFor",
        "replyMessages",
        "replyGroups",
        "replyMetadata",
      ].includes(defined)
    ) report("route, input, family and reply projections belong to client");
    if (node.type === "ImportDeclaration") {
      if (
        path === "packages/ui/registries/shell.ts" &&
        /(?:features|components|shell\/)/.test(node.source.value)
      ) report("registry imports an implementation");
      if (
        path.endsWith("/RightPanel.tsx") &&
        /(?:features|ProjectSessions)/.test(node.source.value)
      ) report("panel host owns a concrete view or its data");
    }
    if (
      node.type === "TSPropertySignature" || node.type === "TSMethodSignature"
    ) {
      const key = property(node.key);
      if (
        path === "packages/ui/registries/prompt.ts" && key &&
        /^(?:promptEnabled|shellEnabled|historyEnabled|agentsEnabled|commandsEnabled|pasteSummary|onAgents|onFind|onMentions|onBump|onCommands|onCommand|onNew|onHistory)$/
          .test(key)
      ) report("prompt owns feature-specific inputs");
      if (
        /^packages\/client\/(?:tabs|inbox)\.ts$/.test(path) &&
        key === "promote" && [...nodes(node)].some((child) =>
          child.type === "Identifier" && child.name === "IndexEntry"
        )
      ) {
        report("tab promotion depends on a replicated status row");
      }
      if (
        ui && key === "onLayout" && [...nodes(node)].some((child) =>
          child.type === "Identifier" &&
          child.typeAnnotation?.type === "TSTypeAnnotation" &&
          child.typeAnnotation.typeAnnotation.type === "TSIndexedAccessType"
        )
      ) {
        report("layout controls must send field intents, not stale snapshots");
      }
    }
    if (
      (node.type === "TSInterfaceDeclaration" ||
        node.type === "TSTypeAliasDeclaration") &&
      ui && node.id.name === "Draft"
    ) report("browser draft model belongs to client");
    if (node.type === "NewExpression") {
      const name = source.name(node.callee);
      if ((shell || binding) && name === "Map") {
        report("shell bindings own no caches");
      }
      if (
        ui && name === "Map" &&
        [...nodes(node)].some((child) =>
          child.type === "Identifier" && child.name === "Draft"
        )
      ) report("browser draft model belongs to client");
      if (path === "web/src/ui/App.tsx" && name === "CommandHub") {
        report("web owns shell behaviour");
      }
    }
    if (node.type === "JSXOpeningElement") {
      const name = source.name(node.name);
      if (
        shell &&
        [
          "PermissionDock",
          "QuestionDock",
          "Palette",
          "KeysHelp",
          "ThemePicker",
          "Editor",
        ].includes(name ?? "")
      ) report("shell builds a registered feature");
      if (shell && source.attr(node, "docks")) {
        report("shell builds a registered feature");
      }
      if (path.endsWith("/RightPanel.tsx") && name === "ProjectSessions") {
        report("panel host owns a concrete view or its data");
      }
      if (
        path.endsWith("/ComposerTakeovers.tsx") &&
        /Permission|Question/.test(name ?? "")
      ) report("takeover host selects concrete attention owners");
      const fallback = source.value(source.attr(node, "fallback"));
      if (
        path.endsWith("/Message.tsx") && fallback?.type === "CallExpression" &&
        fallback.arguments.some((arg) => source.name(arg)?.endsWith(".parts"))
      ) {
        report(
          "part updates must flow through a stable keyed component, not a recreated JSX factory",
        );
      }
    }
    if (
      node.type === "Identifier" && shell &&
      [
        "inboxes",
        "approvalModels",
        "tabModels",
        "navigationRevision",
        "sessionAncestors",
      ].includes(node.name)
    ) report("shell delegates resources and session transactions");
    if (
      node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression"
    ) {
      const name = source.name(node) ?? "";
      if (shell && (name.includes(".rpc.") || name.endsWith(".rpc"))) {
        report("guarded navigation and creation belong to client owners");
      }
      if (path === "web/src/ui/App.tsx" && name.includes(".rpc.")) {
        report("web owns shell behaviour");
      }
    }
    if (
      node.type === "CallExpression" || node.type === "OptionalCallExpression"
    ) {
      const name = source.name(node.callee) ?? "",
        method = name.split(".").at(-1) ?? "";
      if (shell && /(?:^|\.)rpc\.call$/.test(name)) {
        report("guarded navigation and creation belong to client owners");
      }
      if (
        path === "web/src/ui/App.tsx" &&
        ["createSignal", "createEffect", "createStore"].includes(method)
      ) report("web owns shell behaviour");
      if (
        shell &&
        ["createInbox", "createApprovals", "createTabs", "inboxProjects"]
          .includes(method)
      ) report("server resources belong to the client owner");
      if (
        shell &&
        [
          "createTaskActions",
          "createNavigation",
          "route",
          "projectRoute",
          "hashFor",
          "projectHash",
          "confirm",
          "hasFocus",
        ].includes(method)
      ) report("guarded navigation and creation belong to client owners");
      if (
        shell &&
        (["createSessionSubmission", "sessionAncestors"].includes(method) ||
          /(?:history\.attachment|\.tasks\.(?:find|some))$/.test(name) ||
          node.arguments.some((arg) =>
            ["session.prompt", "session.abort", "history.attachment"].includes(
              source.string(arg) ?? "",
            )
          ))
      ) report("session target operations belong to the client owner");
      if (binding && /(?:^|\.)rpc\.call$/.test(name)) {
        report("shell bindings delegate operations and own no caches");
      }
      if ((shell || binding) && method === "supports") {
        report("shell feature availability bypasses reactive advertised state");
      }
      if (path.endsWith("/RightPanel.tsx") && /rpc\.call$/.test(name)) {
        report("panel host owns a concrete view or its data");
      }
      if (
        path.endsWith("/ComposerTakeovers.tsx") &&
        ["permissions", "questions"].includes(method)
      ) report("takeover host selects concrete attention owners");
    }
    if (
      ui && node.type === "SpreadElement" &&
      /(?:^|\.)(?:layout|shellLayout)$/.test(source.name(node.argument) ?? "")
    ) report("layout controls must send field intents, not stale snapshots");
    if (
      ui && node.type === "ObjectProperty" && property(node.key) === "key" &&
      source.string(node.value) === "shellLayout"
    ) report("layout controls must send field intents, not stale snapshots");
    if (
      path.endsWith("/RightPanel.tsx") && node.type === "StringLiteral" &&
      node.value === "sessions"
    ) report("panel host owns a concrete view or its data");
    if (
      path.endsWith("/ToolFrame.tsx") && node.type === "BinaryExpression" &&
      [node.left, node.right].some((child) =>
        source.name(child)?.endsWith("call.tool")
      )
    ) report("tool frame owns feature presentation");
    if (
      path.endsWith("/ToolFrame.tsx") && node.type === "SwitchCase" &&
      ["edit", "bash", "task"].includes(source.string(node.test) ?? "")
    ) report("tool frame owns feature presentation");
    if (
      (path.endsWith("/Message.tsx") || path.endsWith("/work-log.ts")) &&
      node.type === "BinaryExpression" &&
      [node.left, node.right].some((child) =>
        ["tool", "reasoning"].includes(source.string(child) ?? "")
      )
    ) report("work grouping belongs to contributed part presentation");
    if (
      (path.endsWith("/Message.tsx") || path.endsWith("/work-log.ts")) &&
      node.type === "SwitchCase" &&
      ["tool", "reasoning"].includes(source.string(node.test) ?? "")
    ) report("work grouping belongs to contributed part presentation");
  }
  if (path === "packages/client/server-resources.ts") {
    const tabs = source.calls("createTabs");
    if (
      tabs.length !== 1 || tabs[0].arguments[2]?.type !== "ObjectExpression" ||
      !["input", "session"].every((key) =>
        tabs[0].arguments[2].type === "ObjectExpression" &&
        tabs[0].arguments[2].properties.some((p) =>
          p.type === "ObjectProperty" && property(p.key) === key
        )
      )
    ) report("shell tabs lack owner-current inputs and session resolution");
  }
  return [...errors];
}
