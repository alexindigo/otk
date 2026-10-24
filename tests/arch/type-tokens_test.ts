// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { uiSources } from "./analysis.ts";
import { rules, words } from "./styles.ts";

// Consumer values matching the shared type scale must use its tokens.
Deno.test("shared type sizes and line metrics have no literal consumer copies", async () => {
  const errors: string[] = [];
  for (const [path, css] of await uiSources()) {
    if (!path.endsWith(".css")) continue;
    for (const rule of rules(css)) {
      for (const [property, value] of rule.declarations) {
        if (path === "packages/ui/theme.css" && property.startsWith("--")) {
          continue;
        }
        const sizes = property === "font" || property === "font-size";
        const metrics = property === "font" || property === "line-height";
        if (
          words(value).some((word) =>
            sizes && ["12px", "13px", "14px", "16px"].includes(word) ||
            metrics && ["20px", "24px"].includes(word)
          )
        ) errors.push(`${path}: ${rule.selector}: ${property}: ${value}`);
      }
    }
  }
  assertEquals(errors, [], errors.join("\n"));
});
