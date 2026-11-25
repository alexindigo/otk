// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";

/** Native activation belongs to ActionButton; legacy sites are frozen below. */
export function actionControls(path: string, text: string): number[] {
  const source = new Source(text, path);
  const yields = (
    node: t.Node | undefined | null,
    names: readonly string[],
    seen = new Set<t.Node>(),
  ): boolean => {
    const value = source.value(node);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    if (names.includes(source.string(value) ?? "")) return true;
    const child = (node: t.Node | undefined | null) =>
      yields(node, names, new Set(seen));
    switch (value.type) {
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return child(value.body);
      case "BlockStatement":
        return value.body.some(child);
      case "ReturnStatement":
        return child(value.argument);
      case "IfStatement":
      case "ConditionalExpression":
        return child(value.consequent) || child(value.alternate);
      case "LogicalExpression":
        return child(value.left) || child(value.right);
      case "SequenceExpression":
        return child(value.expressions.at(-1));
      default:
        return false;
    }
  };
  return source.all.filter((node): node is t.JSXOpeningElement => {
    if (node.type !== "JSXOpeningElement") return false;
    const attributes = node.attributes.filter((a): a is t.JSXAttribute =>
      a.type === "JSXAttribute"
    );
    const role = attributes.find((a) => property(a.name) === "role");
    const type = attributes.find((a) => property(a.name) === "type");
    const name = property(node.name);
    const factory = name &&
      source.value(source.binding(name, node.name)?.value);
    const imported = factory && factory.type === "CallExpression"
      ? source.imported(factory.callee)
      : undefined;
    const tags = (names: readonly string[]) =>
      names.includes(name ?? "") ||
      yields(source.attr(node, "component"), names) ||
      yields(source.attr(node, "as"), names) ||
      !!(factory && factory.type === "CallExpression" &&
        imported?.module === "@solidjs/web" && imported.name === "dynamic" &&
        yields(factory.arguments[0], names));
    const native = tags(["button"]) ||
      (tags(["input"]) && yields(type?.value, ["button", "submit", "reset"])) ||
      yields(role?.value, ["button", "menuitem", "tab"]);
    return native;
  }).map((node) => node.loc!.start.line);
}

// M6 work packages are listed in m6-failures-feedback/plan.md and its addenda.
// The initial inventory is frozen at adoption; counts may only shrink.
const PENDING: Record<string, number> = {
  "packages/ui/components/ActivityGroup.tsx": 1,
  "packages/ui/components/ChoiceFrame.tsx": 2,
  "packages/ui/components/ChromeMeta.tsx": 1,
  "packages/ui/components/CommandMenu.tsx": 1,
  "packages/ui/components/ComposerNotice.tsx": 1,
  "packages/ui/components/ConnectionBadge.tsx": 1,
  "packages/ui/components/DeletedSession.tsx": 3,
  "packages/ui/components/DisclosureToggle.tsx": 1,
  "packages/ui/components/EdgeTriangle.tsx": 1,
  "packages/ui/components/FailureContent.tsx": 2,
  "packages/ui/components/FeedbackStatus.tsx": 1,
  "packages/ui/components/FittedActions.tsx": 2,
  "packages/ui/components/ForkNote.tsx": 1,
  "packages/ui/components/Form.tsx": 2,
  "packages/ui/components/FormDock.tsx": 6,
  "packages/ui/components/FormField.tsx": 3,
  "packages/ui/components/JumpToLatest.tsx": 1,
  "packages/ui/components/KeysHelp.tsx": 3,
  "packages/ui/components/ListPicker.tsx": 2,
  "packages/ui/components/ListRow.tsx": 2,
  "packages/ui/components/MessageActions.tsx": 1,
  "packages/ui/components/OperationFeedback.tsx": 1,
  "packages/ui/components/Palette.tsx": 1,
  "packages/ui/components/PermissionActivity.tsx": 1,
  "packages/ui/components/PermissionDock.tsx": 4,
  "packages/ui/components/PreferenceControls.tsx": 1,
  "packages/ui/components/PrimaryAction.tsx": 1,
  "packages/ui/components/ProjectChip.tsx": 2,
  "packages/ui/components/ProjectInbox.tsx": 5,
  "packages/ui/components/ProjectSessions.tsx": 1,
  "packages/ui/components/ProjectTabs.tsx": 3,
  "packages/ui/components/QuestionDock.tsx": 2,
  "packages/ui/components/Reasoning.tsx": 1,
  "packages/ui/components/RequestDismiss.tsx": 2,
  "packages/ui/components/RevertGroup.tsx": 2,
  "packages/ui/components/RightPanel.tsx": 1,
  "packages/ui/components/SavedBranches.tsx": 7,
  "packages/ui/components/SessionView.tsx": 1,
  "packages/ui/components/Settings.tsx": 2,
  "packages/ui/components/Sidebar.tsx": 4,
  "packages/ui/components/SidebarRow.tsx": 1,
  "packages/ui/components/SubagentBar.tsx": 3,
  "packages/ui/components/Tabs.tsx": 1,
  "packages/ui/components/TakeoverHeader.tsx": 1,
  "packages/ui/components/ThemePicker.tsx": 3,
  "packages/ui/components/Timeline.tsx": 1,
  "packages/ui/components/Toasts.tsx": 4,
  "packages/ui/components/WorkLog.tsx": 1,
  "packages/ui/components/parts/FilePart.tsx": 1,
  "packages/ui/components/parts/NativeSource.tsx": 1,
  "packages/ui/components/parts/UnknownPart.tsx": 1,
  "packages/ui/components/prompt/Autocomplete.tsx": 1,
  "packages/ui/components/prompt/Chips.tsx": 2,
  "packages/ui/components/prompt/Editor.tsx": 2,
  "packages/ui/components/surface/Dialog.tsx": 1,
  "packages/ui/components/surface/Popover.tsx": 1,
  "packages/ui/components/tools/ToolFrame.tsx": 1,
  "packages/ui/features/project-settings.tsx": 6,
  "packages/ui/features/projects.tsx": 1,
  "packages/ui/features/prompt/agents.tsx": 1,
  "packages/ui/features/prompt/approvals.tsx": 1,
  "packages/ui/features/prompt/attachments.tsx": 1,
  "packages/ui/features/prompt/editor.tsx": 1,
  "packages/ui/features/prompt/skills.tsx": 1,
  "packages/ui/shell/Shell.tsx": 2,
};

Deno.test("action-control architecture rejects direct and spread handlers, including role controls", () => {
  for (
    const text of [
      "<button onClick={run}/>",
      "<button {...handlers}/>",
      '<div role="menuitem" onClick={run}/>',
      '<span role="button" onKeyDown={run}/>',
      '<button type="submit">Save</button>',
      '<input type="button" value="Open"/>',
      '<input type="submit" value="Save"/>',
      '<input type="reset" value="Reset"/>',
      'import { dynamic as tag } from "@solidjs/web"; const kind = "button"; const Control = tag(() => editing ? "div" : kind); <Control {...props}/>',
      'import { dynamic } from "@solidjs/web"; const Control = dynamic(() => props.as ?? "button"); const Alias = Control; <Alias/>',
      '<Dynamic component="button" onClick={run}/>',
      '<div role={active ? "button" : undefined} onClick={run}/>',
    ]
  ) {
    assertEquals(actionControls("Fixture.tsx", text).length, 1);
  }
  assertEquals(
    actionControls(
      "Fixture.tsx",
      "<ActionButton action={owner}>Open</ActionButton>",
    ),
    [],
  );
  assertEquals(
    actionControls("Fixture.tsx", "<span onClick={stopPropagation}/>"),
    [],
  );
  assertEquals(
    actionControls(
      "Fixture.tsx",
      'import { dynamic } from "@solidjs/web"; const Label = dynamic(() => "span"); <Label/>',
    ),
    [],
  );
});

Deno.test("action-control architecture has no new owner bypasses", async () => {
  const actual: Record<string, number> = {};
  for (const [path, text] of await productionSources()) {
    if (
      !/^(?:packages\/ui\/|web\/src\/)/.test(path) || !path.endsWith(".tsx")
    ) continue;
    if (path === "packages/ui/components/ActionButton.tsx") {
      assert(text.includes("props.action.run()"));
      assert(!text.includes("props.onClick"));
      continue;
    }
    const lines = actionControls(path, text);
    if (lines.length) actual[path] = lines.length;
  }
  console.log("ACTION CONTROL INVENTORY", JSON.stringify(actual));
  assertEquals(actual, PENDING);
});
