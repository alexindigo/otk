// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { pathsFromNul, select, validateCollection } from "./selection.ts";
import map from "../../tests/browser/areas.json" with { type: "json" };
Deno.test("SEL1: every standard integration file has an area owner", async () => {
  const mapped = new Set(Object.values(map.integration).flat());
  const actual = new Set<string>();
  for await (const entry of Deno.readDir("tests/integration")) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) actual.add(entry.name);
  }
  assertEquals(mapped, actual);
});
Deno.test("SEL1: publish controlled composer paths for the real selected lane", async () => {
  await Deno.mkdir(".test-state/selection-inputs", { recursive: true });
  await Deno.writeTextFile(
    ".test-state/selection-inputs/composer.paths",
    "packages/ui/features/prompt/prompt.tsx\0",
  );
});
Deno.test("SEL1: actual mapped Playwright inventories retain smoke and reject empty", async () => {
  const child = await new Deno.Command("npm", {
    args: ["--prefix", "tests/browser", "run", "acceptance:selection"],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  assertEquals(child.code, 0);
});
Deno.test("SEL1: NUL names, old/new rename, deletions and broad fallback", () => {
  const paths = pathsFromNul(
    new TextEncoder().encode(
      "old\nname.ts\0packages/ui/features/prompt/editor.tsx\0",
    ),
  );
  assertEquals(paths.length, 2);
  assert(select(paths, [], "HEAD").broad);
  assert(select(["removed/unknown.ts"], [], "HEAD").broad);
  assert(select([], [], "missing").broad);
  assertThrows(() => pathsFromNul(new TextEncoder().encode("x\n")));
});
Deno.test("@load @harness SEL1: acquisition, publication, projection and scheduling changes select permanent load contracts", () => {
  for (
    const path of [
      "packages/client/index.ts",
      "packages/client/server-resources.ts",
      "packages/client/project-projection.ts",
      "packages/client/transcript-projection.ts",
      "packages/client/tabs.ts",
      "packages/client/task-breadcrumbs.ts",
      "packages/client/session-tree.ts",
      "core/index/store.ts",
      "core/ws/connections.ts",
      "core/digest/worker.ts",
      "packages/harness/digest-scheduler.ts",
    ]
  ) {
    const selection = select([path], [], "HEAD");
    assert(selection.areas.includes("load"), path);
    assert(selection.smoke, path);
    if (!selection.broad) {
      for (const file of map.integration.load) {
        assert(
          selection.integration.includes(`tests/integration/${file}`),
          `${path}: ${file}`,
        );
      }
    } else assertEquals(selection.integration, ["*"]);
  }
});
Deno.test("SEL1: exact map contracts and explicit union", () => {
  for (
    const [path, expected] of [
      ["packages/ui/features/prompt/editor.tsx", [
        "composer",
        "attention",
        "menus",
      ]],
      ["packages/client/transcript.ts", ["messages", "sessions", "revert"]],
      ["packages/client/navigation.ts", [
        "sessions",
        "revert",
        "composer",
        "transport",
      ]],
      ["packages/ui/features/approvals.tsx", [
        "attention",
        "sessions",
        "composer",
      ]],
      ["packages/ui/Popover.tsx", ["menus", "composer", "sessions", "visual"]],
    ] as [string, string[]][]
  ) {
    const result = select([path], ["harness"], "HEAD");
    for (const area of expected) assert(result.areas.includes(area));
    assert(result.areas.includes("harness"));
    assert(!result.scale);
  }
  assert(select(["packages/ui/theme.css"], [], "HEAD").themes);
  assert(select(["packages/store/schema.sql"], [], "HEAD").broad);
  assert(select(["core/transport.ts"], [], "HEAD").milestone);
  assert(select(["deno.lock"], [], "HEAD").broad);
  assert(select(["tests/support/session-scale.ts"], [], "HEAD").scale);
  assertEquals(select(["docs/testing.md"], [], "HEAD").areas, []);
  assert(select(["docs/executable.ts"], [], "HEAD").broad);
  assertThrows(() => validateCollection([]));
  assertThrows(() => validateCollection([["@smoke"]]));
  assertThrows(() => validateCollection([["@composer"]], ["menus"]));
});
