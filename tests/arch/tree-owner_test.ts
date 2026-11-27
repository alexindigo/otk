// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { cssTree, rules, selectorAlternatives, variables } from "./styles.ts";

const components = "packages/ui/components";
const sidebars = ["ProjectInbox", "ProjectSessions"];

Deno.test("both sidebars render hierarchy through TreeNode and SidebarRow", async () => {
  for (const name of sidebars) {
    const source = new Source(
      await Deno.readTextFile(`${components}/${name}.tsx`),
    );
    const renders = new Set(
      source.all.filter((n) => n.type === "JSXOpeningElement").map((n) =>
        source.name(n.name)
      ),
    );
    for (const shared of ["TreeNode", "SectionHeader", "SidebarRow"]) {
      assert(renders.has(shared), `${name}: ${shared}`);
    }
    assert(
      !source.all.some((n) =>
        n.type === "ImportDeclaration" && /ListRow/.test(n.source.value)
      ),
      name,
    );
  }
  assert(
    !(await Deno.readTextFile(`${components}/Tree.tsx`)).includes("TreeGuide"),
  );
});

Deno.test("sidebar CSS does not own tree tracks or row geometry", async () => {
  for (const name of sidebars) {
    for (
      const { selector, declarations } of rules(
        await Deno.readTextFile(`${components}/${name}.css`),
      )
    ) {
      assert(!selector.includes(".otk-tree-"), `${name}: ${selector}`);
      for (const key of declarations.keys()) {
        assert(!key.startsWith("--tree-"), `${name}: ${key}`);
        if (
          /otk-(?:session-row|session-group|project-row|project-tree)\b/.test(
            selector,
          ) && !selector.includes(".otk-session-title")
        ) {
          assert(
            !/^(?:(?:min-)?height|(?:min-)?block-size|padding(?:-|$))/.test(
              key,
            ),
            `${name}: ${selector} ${key}`,
          );
        }
      }
    }
  }
});

Deno.test("the only live disclosure instance is owned by shell state", async () => {
  const owners: string[] = [];
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (!["tests", "node_modules", ".test-state"].includes(entry.name)) {
          await walk(path);
        }
      } else if (/\.tsx?$/.test(path)) {
        const text = await Deno.readTextFile(path);
        assert(
          !/\bcreate(?:Project|SessionGroup)Disclosure\b/.test(text),
          path,
        );
        if (text.includes("createDisclosures")) {
          const source = new Source(text);
          for (const node of source.all) {
            if (
              node.type === "CallExpression" &&
              source.name(node.callee) === "createDisclosures"
            ) {
              // Only the injected constructor's default serves standalone callers.
              const parent = source.parent.get(node);
              if (
                path === "packages/client/transcript-interaction.ts" &&
                parent?.type === "AssignmentPattern" &&
                parent.right === node &&
                source.name(parent.left) === "disclosures"
              ) continue;
              owners.push(path);
            }
          }
        }
      }
    }
  }
  await walk("packages/ui");
  await walk("packages/client");
  await walk("web/src");
  assertEquals(owners, ["packages/ui/state/shell.ts"]);
});

Deno.test("flat and nested TreeNode paths share the same lanes and disclosure control", async () => {
  const text = await Deno.readTextFile("packages/ui/components/Tree.tsx");
  const node = text.slice(text.indexOf("export function TreeNode"));
  assert(node.includes("path?: readonly boolean[]"));
  const source = new Source(node);
  const elements = source.all.filter((n) => n.type === "JSXOpeningElement")
    .map((n) => source.name(n.name));
  assertEquals(
    elements.filter((name) => name === "DisclosureToggle").length,
    1,
  );
  assertEquals(elements.filter((name) => name === "TreeLanes").length, 2);
  assert(node.includes("<TreeLanesContext value={region}>"));
});

const tree = `${components}/Tree`;
const laneTokens = ["--tree-indent", "--tree-box-size"];

async function* files(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* files(path);
    else if (entry.isFile) yield path;
  }
}

Deno.test("Tree.css alone declares lane tokens and owns lane selectors and tracks", async () => {
  const definitions: string[] = [];
  const violations: string[] = [];
  for await (const path of files("packages/ui")) {
    if (!path.endsWith(".css")) continue;
    for (
      const { selector, declarations } of rules(await Deno.readTextFile(path))
    ) {
      for (const token of laneTokens) {
        if (declarations.has(token)) definitions.push(`${path}: ${token}`);
      }
      if (path === `${tree}.css`) continue;
      if (selector.includes(".otk-tree-")) {
        violations.push(`${path}: ${selector}`);
      }
      const columns = declarations.get("grid-template-columns");
      if (
        columns &&
        variables(columns).some(({ name }) => name === "--tree-indent")
      ) {
        violations.push(`${path}: ${selector} grid-template-columns`);
      }
    }
  }
  assertEquals(
    definitions.sort(),
    laneTokens.map((token) => `${tree}.css: ${token}`).sort(),
  );
  assertEquals(violations, []);
});

Deno.test("TreeLanes is the only lane renderer and Tree the only lane-state consumer", async () => {
  const imports: string[] = [];
  const renderers: string[] = [];
  for (const root of ["packages", "web/src"]) {
    for await (const path of files(root)) {
      if (!/\.tsx?$/.test(path) || path.split("/").includes("tests")) continue;
      const text = await Deno.readTextFile(path);
      if (!/laneStates|data-lane-segment|TreeLanes/.test(text)) continue;
      const source = new Source(text, path);
      for (const n of source.all) {
        if (
          n.type === "ImportSpecifier" &&
          source.name(n.imported) === "laneStates"
        ) imports.push(path);
        if (
          n.type === "JSXAttribute" &&
          source.name(n.name) === "data-lane-segment"
        ) {
          let owner = source.parent.get(n);
          while (owner && owner.type !== "FunctionDeclaration") {
            owner = source.parent.get(owner);
          }
          renderers.push(`${path}:${owner?.id?.name}`);
        }
      }
    }
  }
  assertEquals(imports, [`${tree}.tsx`]);
  assertEquals([...new Set(renderers)], [`${tree}.tsx:TreeLanes`]);
});

Deno.test("legacy transcript tree geometry is retired", async () => {
  const violations: string[] = [];
  const retired =
    /\b(?:TreeIcon|TreeConnector|IconStemContext|otk-tree-continuation|otk-tree-body)\b|--tree-content-gutter\b/;
  for (const root of ["packages/ui", "web/src"]) {
    for await (const path of files(root)) {
      if (!/\.(?:tsx?|css|md)$/.test(path)) continue;
      const match = (await Deno.readTextFile(path)).match(retired);
      if (match) violations.push(`${path}: ${match[0]}`);
    }
  }
  assertEquals(violations, []);
});

Deno.test("tree row spacing is a lane gap, never a margin on a TreeNode", async () => {
  const rowClasses = new Set([
    "otk-tool-line",
    "otk-tree-node",
    "otk-tree-row",
  ]);
  const styles = [];
  for await (const path of files(components)) {
    if (path.endsWith(".css")) styles.push(path);
    if (!path.endsWith(".tsx")) continue;
    const text = await Deno.readTextFile(path);
    if (!text.includes("<TreeNode")) continue;
    const source = new Source(text, path);
    for (const node of source.all) {
      if (
        node.type !== "JSXOpeningElement" ||
        source.name(node.name) !== "TreeNode"
      ) continue;
      const classes = source.value(source.attr(node, "class"));
      if (!classes) continue;
      for (const candidate of source.all) {
        if (
          candidate.type !== "StringLiteral" ||
          candidate.start! < classes.start! ||
          candidate.end! > classes.end!
        ) continue;
        for (const token of candidate.value.split(/\s+/).filter(Boolean)) {
          rowClasses.add(token);
        }
      }
    }
  }
  const violations = [];
  for (const path of styles) {
    for (
      const { selector, declarations } of rules(await Deno.readTextFile(path))
    ) {
      if (
        ![...declarations.keys()].some((name) => /^margin(?:-|$)/.test(name))
      ) continue;
      for (const branch of selectorAlternatives(selector)) {
        const parsed = cssTree.parse(branch, { context: "selector" });
        if (parsed.type !== "Selector") continue;
        const parts = parsed.children.toArray();
        const target = parts.slice(
          parts.findLastIndex((part) => part.type === "Combinator") + 1,
        );
        if (
          target.some((part) =>
            part.type === "ClassSelector" && rowClasses.has(part.name)
          )
        ) {
          violations.push(`${path}: ${branch}`);
        }
      }
    }
  }
  assertEquals(violations, []);
});
