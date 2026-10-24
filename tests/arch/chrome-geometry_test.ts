// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { rules, words } from "./styles.ts";

Deno.test("shared chrome dimensions have no copied rail header or compact-control values", async () => {
  const owners = new Map([
    ["packages/ui/components/SidebarRail.css", ["48px", "52px"]],
    ["packages/ui/components/ProjectInbox.css", ["52px", "28px"]],
    ["packages/ui/components/ProjectTabs.css", ["52px", "28px"]],
    ["packages/ui/components/RightPanel.css", ["52px"]],
    ["packages/ui/components/DisplayMenu.css", ["28px"]],
    ["packages/ui/theme.css", ["28px"]],
  ]);
  const errors: string[] = [];
  for (const [path, css] of await uiSources()) {
    const copied = owners.get(path);
    if (!copied) continue;
    for (const rule of rules(css)) {
      for (const [property, value] of rule.declarations) {
        if (property === "--control-size") continue;
        if (words(value).some((word) => copied.includes(word))) {
          errors.push(`${path}: ${rule.selector}: ${property}: ${value}`);
        }
      }
    }
  }
  assertEquals(errors, [], errors.join("\n"));
});

Deno.test("resize views consume protocol bounds rather than copied numeric policies", async () => {
  const errors: string[] = [];
  for (
    const path of [
      "packages/ui/components/ProjectInbox.tsx",
      "packages/ui/components/RightPanel.tsx",
    ]
  ) {
    const source = new Source(await Deno.readTextFile(path), path);
    for (const node of source.all) {
      if (
        node.type === "NumericLiteral" &&
        [48, 200, 248, 280, 320, 360, 480].includes(node.value)
      ) errors.push(`${path}: ${node.value}`);
    }
  }
  assertEquals(errors, [], errors.join("\n"));
});
