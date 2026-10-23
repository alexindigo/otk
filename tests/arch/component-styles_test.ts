// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import * as css from "css-tree";

// These are private implementation classes, not the public class input on a
// trigger/icon/content slot. Check parsed selectors, including nested :is/:not.
const boundaries = [
  ["components/ProjectTabs.css", [
    "otk-app",
    "otk-popover-trigger",
    "otk-chrome-icon",
  ]],
  ["components/ProjectInbox.css", [
    "otk-status-light",
    "otk-popover-trigger",
    "otk-chrome-icon",
  ]],
  ["components/Message.css", ["otk-text", "otk-work-fold", "otk-work-rule"]],
  ["components/DisplayMenu.css", ["otk-popover-trigger"]],
  ["components/TurnUsage.css", ["otk-popover-trigger"]],
  ["components/Reasoning.css", ["otk-chrome-icon"]],
  ["components/ProjectSessions.css", ["otk-chrome-icon"]],
  ["components/RightPanel.css", ["otk-selection-content"]],
  ["components/Settings.css", ["otk-form"]],
  ["features/prompt/pickers.css", [
    "otk-popover-trigger",
    "otk-prompt-context",
    "otk-chrome-icon",
    "otk-list-picker",
  ]],
  ["components/Prompt.css", [
    "otk-composer-model",
    "otk-composer-model-name",
    "otk-composer-provider",
  ]],
] as const;
for (const [path, forbidden] of boundaries) {
  Deno.test(`component style boundary ${path} does not select foreign internals`, async () => {
    const source = await Deno.readTextFile(
      new URL(`../../packages/ui/${path}`, import.meta.url),
    );
    const found = new Set<string>();
    css.walk(css.parse(source), (node) => {
      if (
        node.type === "ClassSelector" &&
        forbidden.some((name) => name === node.name)
      ) found.add(node.name);
    });
    assertEquals(
      [...found],
      [],
      `${path} reaches a different component's implementation`,
    );
  });
}
