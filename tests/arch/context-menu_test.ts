// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

function errors(name: string, source: string): string[] {
  const errors: string[] = [];
  if (
    name !== "components/ContextMenu.tsx" &&
    /onContextMenu|(?:addEventListener|removeEventListener)\s*\(\s*["'`]contextmenu["'`]/
      .test(source)
  ) {
    errors.push("contextmenu listener belongs to ContextMenu");
  }
  if (
    name !== "components/ContextMenu.tsx" && /\.key\b/.test(source) &&
    /["'`](?:ContextMenu|F10)["'`]/.test(source)
  ) {
    errors.push("context-menu keyboard opening belongs to ContextMenu");
  }
  if (/data-context-(?:kind|target)|oncontextmenu/i.test(source)) {
    errors.push("targets use the shared contextTarget binding");
  }
  return errors;
}
async function inspect(directory: URL, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name === "tests") continue;
    if (entry.isDirectory) {
      result.push(
        ...await inspect(
          new URL(`${entry.name}/`, directory),
          `${prefix}${entry.name}/`,
        ),
      );
    } else if (/\.tsx?$/.test(entry.name)) {
      result.push(
        ...errors(
          prefix + entry.name,
          await Deno.readTextFile(new URL(entry.name, directory)),
        ),
      );
    }
  }
  return result;
}
Deno.test("context menus have one shell-root listener owner and declarative target bindings", async () => {
  const ui = new URL("../../packages/ui/", import.meta.url);
  assertEquals(await inspect(ui), []);
  assertEquals(
    await inspect(new URL("../../web/", import.meta.url), "web/"),
    [],
  );
  const owner = await Deno.readTextFile(
    new URL("components/ContextMenu.tsx", ui),
  );
  assertEquals(
    [...owner.matchAll(/addEventListener\("contextmenu"/g)].length,
    1,
  );
  assert(owner.includes('root.addEventListener("contextmenu", pointer, true)'));
  assert(owner.includes("contextTargets([node])"));
  assert(owner.includes("<CommandMenu"));
  for (
    const source of [
      "onContextMenu={() => {}}",
      'el.addEventListener("contextmenu", handler)',
      "el.addEventListener(`contextmenu`, handler)",
      "if (event.key === `ContextMenu`) open()",
      'if (event.shiftKey && event.key === "F10") open()',
      'if (["ContextMenu", "F10"].includes(event.key)) open()',
      '<div data-context-kind="session"/>',
    ]
  ) {
    assert(errors("components/Other.tsx", source).length, source);
    assert(errors("web/src/ui/Other.tsx", source).length, source);
  }
});
