// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DEFAULT_PREFS, TEXT_SIZES } from "@otk/protocol";
import { paintVisualPreferences } from "../features/visual.ts";

Deno.test("visual painter applies the authoritative size as one root scale", () => {
  const properties = new Map<string, string>(),
    attributes = new Map<string, boolean>();
  const doc = {
    documentElement: {
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
      },
      toggleAttribute: (key: string, value: boolean) =>
        attributes.set(key, value),
    },
  } as unknown as Document;
  for (const textSize of TEXT_SIZES) {
    paintVisualPreferences({ ...DEFAULT_PREFS, textSize }, doc);
    assertEquals([...properties], [[
      "--otk-scale",
      String(Number(textSize) / 100),
    ]]);
  }
  paintVisualPreferences({
    ...DEFAULT_PREFS,
    reducedColors: true,
    animationsOff: true,
  }, doc);
  assertEquals(properties.get("--otk-scale"), "1");
  assertEquals([...attributes.values()], [true, true]);
});

Deno.test("production spacing cannot bypass the root-scaled token contract", async () => {
  const violations: string[] = [];
  async function inspect(directory: URL): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name === "tests") continue;
      const path = new URL(
        entry.name + (entry.isDirectory ? "/" : ""),
        directory,
      );
      if (entry.isDirectory) await inspect(path);
      else if (entry.name.endsWith(".css")) {
        const css = await Deno.readTextFile(path);
        for (
          const match of css.matchAll(
            /^\s*(?:gap|row-gap|column-gap|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?):[^;]*\b\d+(?:\.\d+)?px\b/gm,
          )
        ) {
          violations.push(`${path.pathname}: ${match[0].trim()}`);
        }
      }
    }
  }
  await inspect(new URL("../", import.meta.url));
  assertEquals(violations, []);
});

Deno.test("tool rows and shared trees inherit scaled geometry", async () => {
  const read = (path: string) =>
    Deno.readTextFile(new URL(path, import.meta.url));
  const theme = await read("../theme.css");
  const tool = await read("../components/tools/ToolFrame.css");
  const tree = await read("../components/Tree.css");
  assertEquals(theme.includes("--row-tool: calc(26 * var(--otk-unit))"), true);
  assertEquals(tool.includes("min-height: var(--row-tool)"), true);
  assertEquals(tree.includes("--tree-icon-size: var(--icon-compact)"), true);
  assertEquals(tree.includes("min-block-size: var(--tree-row-height)"), true);
  assertEquals(tool.includes("flex: 0 0 var(--icon-compact)"), true);
  assertEquals(tool.includes("width: var(--icon-compact)"), true);
});
