// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { rules } from "./styles.ts";

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

Deno.test("flat TreeNode paths share the nested junction and disclosure control", async () => {
  const text = await Deno.readTextFile("packages/ui/components/Tree.tsx");
  const node = text.slice(text.indexOf("export function TreeNode"));
  assert(node.includes("path?: readonly boolean[]"));
  const source = new Source(node);
  const elements = source.all.filter((n) => n.type === "JSXOpeningElement")
    .map((n) => source.name(n.name));
  assertEquals(elements.filter((name) => name === "Junction").length, 1);
  assertEquals(
    elements.filter((name) => name === "DisclosureToggle").length,
    1,
  );
  assertEquals(elements.filter((name) => name === "TreeRails").length, 1);
  assert(node.includes("<IconStemContext value={stem}>"));
});
