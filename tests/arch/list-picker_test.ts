// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
const root = new URL("../../", import.meta.url);
function errors(path: string, source: string): string[] {
  const result: string[] = [];
  if (path.startsWith("packages/ui/") && /plan_exit|plan_enter/.test(source)) {
    result.push("tool-driven agent selection belongs to the client owner");
  }
  if (path.endsWith("ListPicker.tsx")) {
    if (
      /\brpc\b|@otk\/client|prefs\.|querySelector|\.parentElement/.test(source)
    ) {
      result.push(
        "picker owns interaction only, with injected data and callbacks",
      );
    }
    if (
      !source.includes("<Popover") || !source.includes("<SelectionContent") ||
      !source.includes("...selection(")
    ) result.push("picker must use shared surface and selection owners");
  }
  if (
    path.endsWith("Prompt.tsx") &&
    /models\.list|agents\.list|ListPicker|chooseModel|chooseVariant/.test(
      source,
    )
  ) {
    result.push(
      "prompt host consumes contributions, not concrete picker implementations",
    );
  }
  if (
    path.endsWith("features/prompt/agents.tsx") &&
    /JSON\.parse|modelGroups\(|toggleFavouriteModel\(|recordRecentModel\(|new Promise|let (?:queue|preferences)|choose(?:Agent|Model|Variant)\(draft/
      .test(source)
  ) {
    result.push(
      "composer catalog, selection and preference logic belongs to the client owner",
    );
  }
  if (
    path.endsWith("features/prompt/catalog.ts") &&
    /createSignal|let pending|function promptCatalog|\.then\(|\.finally\(/.test(
      source,
    )
  ) {
    result.push("catalog UI module binds the framework-free owner only");
  }
  if (
    path.endsWith("Prompt.tsx") &&
    /nextSelection:\s*\(draft\s*=\s*change\(/.test(source)
  ) result.push("rendered selection reads the reactive draft");
  return result;
}
Deno.test("ListPicker uses shared owners and prompt selection flows through one contributed projection", async () => {
  for (
    const path of [
      "packages/ui/components/ListPicker.tsx",
      "packages/ui/components/Prompt.tsx",
      "packages/ui/features/prompt/agents.tsx",
      "packages/ui/features/prompt/catalog.ts",
      "packages/ui/registries/session.tsx",
      "packages/ui/shell/Shell.tsx",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(path, root));
    assertEquals(errors(path, source), []);
  }
  for (
    const invalid of [
      "ctx.rpc('models.list')",
      "prefs.models",
      "element.parentElement",
      "document.querySelector('.prompt')",
    ]
  ) {
    assert(
      errors(
        "ListPicker.tsx",
        `<Popover><SelectionContent {...selection({})} />${invalid}`,
      ).length,
    );
  }
  assert(errors("Prompt.tsx", "models.list").length);
  assert(
    errors(
      "packages/ui/features/prompt/catalog.ts",
      'part.name === "plan_exit"',
    ).length,
  );
  assert(
    errors("packages/ui/shell/Shell.tsx", 'part.name === "plan_enter"').length,
  );
  assert(
    errors("Prompt.tsx", "nextSelection: (draft = change((value) => value))")
      .length,
  );
  for (
    const invalid of [
      "JSON.parse(key)",
      "modelGroups(catalog)",
      "toggleFavouriteModel(prefs, ref)",
      "let queue = Promise.resolve()",
      "chooseModel(draft, model)",
    ]
  ) assert(errors("features/prompt/agents.tsx", invalid).length);
  assert(
    errors("features/prompt/catalog.ts", "let pending = load().then(apply)")
      .length,
  );
  const prompt = await Deno.readTextFile(
    new URL("packages/ui/components/Prompt.tsx", root),
  );
  assert(prompt.includes("feature.submit?.(draft, parts, selection)"));
  assert(prompt.includes("send({ parts, mode: draft.mode, selection })"));
  assert(
    prompt.indexOf("await ctx.ready()") < prompt.indexOf("let draft = change("),
  );
  const picker = await Deno.readTextFile(
    new URL("packages/ui/components/ListPicker.tsx", root),
  );
  assert(
    picker.includes("<Show when={opened()}>") &&
      picker.includes("buttons.clear()"),
  );
  assert(
    !picker.includes('"★"') && !picker.includes('"☆"'),
    "Generic actions inject their own content",
  );
});
