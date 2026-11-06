// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { rules, words } from "./styles.ts";

/** No exceptions: code blocks and native fields borrow the primitive too. */
function scrollDeclarations(css: string): string[] {
  return rules(css).flatMap((rule) =>
    [...rule.declarations].filter(([property, value]) =>
      /^overscroll-behavior(?:-[xy]|-block|-inline)?$/.test(property) ||
      /^overflow(?:-[xy]|-block|-inline)?$/.test(property) &&
        words(value).some((word) => word === "auto" || word === "scroll")
    ).map(([property]) => `${rule.selector}: ${property}`)
  );
}

Deno.test("scroll policy cannot be redeclared outside ScrollRegion", async () => {
  const violations: string[] = [];
  async function visit(root: URL): Promise<void> {
    for await (const entry of Deno.readDir(root)) {
      const path = new URL(entry.name + (entry.isDirectory ? "/" : ""), root);
      if (entry.name === "tests" || entry.name === "node_modules") continue;
      if (entry.isDirectory) await visit(path);
      else if (
        entry.name.endsWith(".css") && entry.name !== "ScrollRegion.css"
      ) {
        violations.push(
          ...scrollDeclarations(await Deno.readTextFile(path)).map((value) =>
            `${path.pathname}: ${value}`
          ),
        );
      }
    }
  }
  await visit(new URL("../../packages/ui/", import.meta.url));
  assertEquals(violations, []);
  const primitive = scrollDeclarations(
    await Deno.readTextFile(
      new URL("../../packages/ui/components/ScrollRegion.css", import.meta.url),
    ),
  );
  assertEquals(primitive, [
    ":where(.otk-scroll): overflow",
    ":where(.otk-scroll): overscroll-behavior",
    ":where(.otk-scroll-x): overscroll-behavior-y",
    ":where(.otk-scroll-y): overscroll-behavior-x",
  ]);
});

Deno.test("scroll policy inspection catches nested and alternate-axis bypasses", () => {
  assertEquals(
    scrollDeclarations(
      `.outer { .inner { overflow-y: auto; } } @media (width > 600px) { .code { overflow: hidden scroll; overscroll-behavior-x: none; } }`,
    ).length,
    3,
  );
  assertEquals(
    scrollDeclarations(`.clip { overflow: clip; overflow-anchor: none; }`),
    [],
  );
});
