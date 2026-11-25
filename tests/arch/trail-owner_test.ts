// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { browserGrep, select } from "../../scripts/tests/selection.ts";
import { literal, nodes, parse, property } from "./syntax.ts";

/** Trail creation is private to the client owner. Views receive its model;
 * ancestry, working inventory and task partition cannot grow parallel trails. */
function parallelTrail(path: string, source: string): boolean {
  if (path.endsWith("/client/task-breadcrumbs.ts")) return false;
  for (const node of nodes(parse(source, path))) {
    // Detect the representation, not just known function names. Renaming a
    // second builder or constructing its rows in a map still violates ownership.
    if (node.type === "ObjectExpression") {
      const fields = node.properties.filter((p) => p.type === "ObjectProperty");
      const kind = fields.find((p) => property(p.key) === "kind");
      if (
        kind &&
        ["member", "ancestor", "helper"].includes(literal(kind.value) ?? "") &&
        fields.some((p) => property(p.key) === "helper") &&
        fields.some((p) => property(p.key) === "depth")
      ) return true;
    }
    if (
      node.type === "ImportDeclaration" &&
      node.specifiers.some((s) =>
        s.type === "ImportSpecifier" &&
        ["buildTrail", "taskBreadcrumbs"].includes(property(s.imported) ?? "")
      ) &&
      !path.endsWith("/client/tabs.ts")
    ) return true;
    if (
      /\/components\/(?:ProjectTabs|TaskTrail|Subagents)\.tsx$/.test(path) &&
      (node.type === "CallExpression" ||
        node.type === "OptionalCallExpression") &&
      ["family", "path", "working", "sessionAncestors", "runningDescendants"]
        .includes(property(node.callee) ?? "")
    ) return true;
  }
  return /(?:function|const)\s+(?:buildTrail|groupBreadcrumbs|taskBreadcrumbs|runningDescendants)\b/
    .test(source) ||
    /(?:cachedCrumbs|cachedPath|cachedFamily|cachedWorking)\s*=\s*\[/.test(
      source,
    ) ||
    /kind:\s*"(?:member|ancestor|helper)"[^}]*\bhelper:\s*(?:true|false|!!)/
      .test(source) ||
    path.endsWith("/client/tabs.ts") &&
      /\b(?:sessionAncestors|runningDescendants|groupBreadcrumbs)\s*\(/.test(
        source,
      ) ||
    /\/components\/(?:ProjectTabs|TaskTrail|Subagents)\.tsx$/.test(path) &&
      /\.family\(\)|\b(?:sessionAncestors|runningDescendants)\s*\(/.test(
        source,
      );
}
async function* sources(dir: string): AsyncGenerator<string> {
  for await (const file of Deno.readDir(dir)) {
    if (file.name === "tests") continue;
    const path = `${dir}/${file.name}`;
    if (file.isDirectory) yield* sources(path);
    else if (/\.tsx?$/.test(path)) yield path;
  }
}
Deno.test("trail ownership guard rejects parallel builders and accepts borrowed models", () => {
  assert(
    parallelTrail(
      "packages/client/tabs.ts",
      "cachedCrumbs = [...path, ...family]",
    ),
  );
  assert(parallelTrail("packages/ui/other.ts", "function buildTrail() {}"));
  assert(
    parallelTrail(
      "packages/ui/other.ts",
      'const renamed = xs.map(x => ({id:x, depth:1, helper:true, kind:"helper"}))',
    ),
  );
  assert(
    parallelTrail(
      "packages/ui/other.ts",
      'import { taskBreadcrumbs as renamed } from "@otk/client"',
    ),
  );
  assertEquals(
    parallelTrail(
      "packages/ui/other.ts",
      "const rows = model.crumbs().map(crumb => ({...crumb, first: true}))",
    ),
    false,
  );
  assert(
    parallelTrail(
      "packages/ui/components/ProjectTabs.tsx",
      "model.family().filter(active)",
    ),
  );
  assertEquals(
    parallelTrail("packages/client/tabs.ts", "cachedCrumbs = trail.crumbs"),
    false,
  );
  assert(
    parallelTrail(
      "packages/ui/components/TaskTrail.tsx",
      "model.family().filter(active)",
    ),
  );
  assert(
    parallelTrail(
      "packages/ui/components/Subagents.tsx",
      "const helpers = sessionAncestors(id, lookup)",
    ),
  );
});
Deno.test("D67 ancestry and D66 subagents have separate owners", async () => {
  const violations: string[] = [];
  for await (const path of sources("packages")) {
    if (parallelTrail(path, await Deno.readTextFile(path))) {
      violations.push(path);
    }
  }
  assertEquals(violations, []);
  const tabs = await Deno.readTextFile("packages/client/tabs.ts");
  assert(tabs.includes("buildTrail("));
  const ui = await Deno.readTextFile("packages/ui/components/ProjectTabs.tsx");
  assert(ui.includes("props.model.trail()"));
  const renderer = await Deno.readTextFile(
    "packages/ui/components/TaskTrail.tsx",
  );
  assert(renderer.includes("singleLine"));
  assert(renderer.includes("props.model.crumbs"));
  assert(renderer.includes("compactMeasure"));
  assert(!renderer.includes("props.model.helpers"));
  const subagents = await Deno.readTextFile(
    "packages/ui/components/Subagents.tsx",
  );
  assert(subagents.includes("taskHelpers("));
  const composer = await Deno.readTextFile(
    "packages/ui/components/ComposerTakeovers.tsx",
  );
  assert(composer.includes("session.trail?.()"));
  assert(!composer.includes('item.kind === "helper"'));
  assert(!subagents.includes("sessionAncestors"));
  const work = await Deno.readTextFile("packages/ui/components/LiveWork.tsx");
  assert(!work.includes('kind === "helper"'));
});
Deno.test("trail decision contract is selected by session, tab and crumb changes", async () => {
  const contract = await Deno.readTextFile(
    "tests/browser/contracts/decisions/trail.spec.ts",
  );
  const tags = [...contract.matchAll(/"(@[a-z]+)"/g)].map((m) => m[1]).join(
    " ",
  );
  for (
    const path of [
      "packages/client/tabs.ts",
      "packages/client/task-breadcrumbs.ts",
      "packages/client/session-tree.ts",
      "packages/ui/components/ProjectTabs.tsx",
      "packages/ui/components/ProjectTabs.css",
    ]
  ) {
    assert(
      new RegExp(browserGrep(select([path], [], "parent"))).test(
        tags,
      ),
      path,
    );
  }
});
