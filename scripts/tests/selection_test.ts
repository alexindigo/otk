// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  browserGrep,
  pathsFromNul,
  select,
  validateCollection,
} from "./selection.ts";
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
  assert(!select(["packages/store/schema.sql"], [], "HEAD").broad);
  assert(select(["core/service.ts"], [], "HEAD").milestone);
  assert(select(["deno.lock"], [], "HEAD").broad);
  assert(select(["tests/support/session-scale.ts"], [], "HEAD").scale);
  assertEquals(select(["docs/testing.md"], [], "HEAD").areas, []);
  assert(select(["docs/executable.ts"], [], "HEAD").broad);
  assertThrows(() => validateCollection([]));
  assertThrows(() => validateCollection([["@smoke"]]));
  assertThrows(() => validateCollection([["@composer"]], ["menus"]));
});

// D63 bounded per-commit selection contracts.
Deno.test("D63 unmapped paths select contracts, not every behavior area or themes", () => {
  const result = select(["unmapped/file.ts"], [], "parent");
  assertEquals(result.fallback, "contracts");
  assertEquals(result.areas, []);
  assertEquals(result.integration, ["*"]);
  assert(!result.themes);
  assert(result.broad);
  const grep = new RegExp(browserGrep(result));
  assert(grep.test("@contracts"));
  assert(grep.test("@smoke"));
  assert(!grep.test("@messages"));
});

Deno.test("D63 missing base preserves all-area fallback and themes", () => {
  const result = select([], [], "missing");
  assertEquals(result.fallback, "all");
  assertEquals(result.areas, [...map.areas].sort());
  assertEquals(result.integration, ["*"]);
  assert(result.themes);
});

Deno.test("D63 empty and documentation changes retain smoke without extra areas", () => {
  for (const paths of [[], ["docs/testing.md"]]) {
    const result = select(paths, [], "parent");
    assertEquals(result.fallback, null);
    assertEquals(result.areas, []);
    assertEquals(result.integration, []);
    assertEquals(browserGrep(result), "@(smoke)(?:\\s|$)");
    assert(!result.themes);
  }
});

Deno.test("D63 themes need a style path and a row allowing themes", () => {
  for (
    const path of [
      "packages/ui/theme.css",
      "packages/ui/theme/tokens.ts",
      "packages/ui/fonts/mono.woff2",
    ]
  ) {
    assert(select([path], [], "parent").themes, path);
  }
  assert(!select(["packages/ui/components/Message.tsx"], [], "parent").themes);
  assert(!select(["scripts/tests/run.ts"], [], "parent").themes);
});

Deno.test("D63 changed integration tests select themselves and their existing owners", () => {
  const result = select(["tests/integration/history_test.ts"], [], "parent");
  assertEquals(result.fallback, null);
  assertEquals(result.areas, ["composer", "revert"]);
  assert(result.integration.includes("tests/integration/history_test.ts"));
  const added = select(
    ["tests/integration/new-contract_test.ts"],
    [],
    "parent",
  );
  assertEquals(added.areas, []);
  assertEquals(added.integration, ["tests/integration/new-contract_test.ts"]);
  assertEquals(added.fallback, null);
});

Deno.test("D63 unions every matching row, explicit areas and semantic test areas", () => {
  const result = select(
    ["packages/ui/components/Message.css"],
    ["attention"],
    "parent",
  );
  for (
    const area of [
      "messages",
      "sessions",
      "revert",
      "visual",
      "menus",
      "composer",
      "attention",
    ]
  ) {
    assert(result.areas.includes(area), area);
  }
  assertEquals(
    select(["tests/browser/contracts/revert/new.spec.ts"], [], "parent").areas,
    ["revert"],
  );
  assertThrows(() => select([], ["not-an-area"], "parent"));
});

Deno.test("D63 every per-commit area row maps a real path without fallback", async () => {
  for (
    const [path, expected] of [
      ["core/features/revert.ts", ["revert", "messages"]],
      ["core/features/prompt.ts", ["composer", "menus"]],
      ["core/features/approvals.ts", ["attention", "sessions"]],
      ["core/features/sessions.ts", ["sessions", "transport"]],
      ["core/features/prefs.ts", ["visual", "menus", "sessions"]],
      ["core/features/digests.ts", ["load", "messages", "harness"]],
      ["core/index/supervision.ts", ["load", "attention", "sessions"]],
      ["core/http/app.ts", ["transport", "load"]],
      ["main.ts", ["transport", "load"]],
      ["packages/store/db.ts", ["sessions", "messages", "load"]],
      ["packages/harness-opencode-v2-server/adapter.ts", [
        "harness",
        "messages",
        "sessions",
        "transport",
      ]],
      ["packages/protocol/messages.ts", ["messages"]],
      ["packages/protocol/inbox.ts", ["attention", "sessions"]],
      ["packages/protocol/requests.ts", ["transport", "composer"]],
      ["packages/protocol/catalogs/agents.ts", ["menus", "composer", "visual"]],
      ["defaults/otk.toml", ["visual", "menus", "composer"]],
    ] as [string, string[]][]
  ) {
    await Deno.stat(path);
    const result = select([path], [], "HEAD");
    assertEquals(result.fallback, null, path);
    for (const area of expected) assert(result.areas.includes(area), path);
  }
  for (
    const path of [
      "docs/testing.md",
      "core/README.md",
      "LICENSE",
      "tests/unit/catalog-demand_test.ts",
      "tests/arch/analysis_test.ts",
    ]
  ) {
    await Deno.stat(path);
    const result = select([path], [], "HEAD");
    assertEquals(result.fallback, null, path);
    assertEquals(result.areas, [], path);
    assertEquals(result.integration, [], path);
  }
  assert(select(["core/features/revert.ts"], [], "HEAD").areas.length === 2);
  assert(select(["core/service.ts"], [], "HEAD").milestone);
  assert(!select(["defaults/otk.toml"], [], "HEAD").milestone);
  assertEquals(
    select(["packages/protocol/LICENSE"], [], "HEAD").fallback,
    "contracts",
  );
});
