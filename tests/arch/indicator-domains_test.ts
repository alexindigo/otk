// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

function serverBorrowsSession(text: string): boolean {
  const source = new Source(text);
  for (const node of source.all) {
    if (node.type !== "JSXOpeningElement") continue;
    const imported = source.imported(node.name);
    if (
      !imported ||
      !(/StatusLight\.tsx$/.test(imported.module) ||
        imported.module === "@otk/ui" && imported.name === "StatusLight")
    ) continue;
    let parent = source.parent.get(node);
    while (parent) {
      if (
        parent.type === "JSXElement" &&
        source.string(source.attr(parent.openingElement, "class"))?.split(/\s+/)
          .includes("otk-server-status")
      ) return true;
      parent = source.parent.get(parent);
    }
  }
  return false;
}

Deno.test("connection and activity owners do not borrow session indicator states or paint", async () => {
  const errors: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (!path.startsWith("packages/ui/")) continue;
    if (
      /(Connection|connection-light|ActivityIndicator|Reasoning|ToolFrame|features\/notify)/
        .test(path)
    ) {
      if (/\.tsx?$/.test(path)) {
        const source = new Source(text, path);
        for (const node of source.all) {
          if (
            node.type === "ImportDeclaration" &&
            /(?:StatusLight|status-light)\./.test(node.source.value)
          ) {
            errors.push(`${path}: session indicator import`);
          }
        }
      } else if (
        path.endsWith(".css") && /--(?:otk-lamp|status-light)-/.test(text)
      ) {
        errors.push(`${path}: session lamp paint`);
      }
    }
    if (path === "packages/ui/components/ProjectInbox.tsx") {
      if (serverBorrowsSession(text)) {
        errors.push(`${path}: server borrows session indicator`);
      }
    }
  }
  assertEquals(errors, []);
});
Deno.test("server ownership catches aliased session indicators but accepts the connection owner", () => {
  assert(
    serverBorrowsSession(
      'import Lamp from "./StatusLight.tsx"; const row = <button class="otk-server-status"><Lamp state="finished" /></button>;',
    ),
  );
  assert(
    serverBorrowsSession(
      'import {StatusLight as Lamp} from "@otk/ui"; const row = <button class="otk-server-status"><Lamp state="finished" /></button>;',
    ),
  );
  assertEquals(
    serverBorrowsSession(
      'import Lamp from "./ConnectionLight.tsx"; const row = <button class="otk-server-status"><Lamp connection={server} /></button>;',
    ),
    false,
  );
});
Deno.test("session lamps no longer offer a non-session activity mode", async () => {
  const source = new Source(
    await Deno.readTextFile("packages/ui/components/StatusLight.tsx"),
  );
  assertEquals(
    source.all.filter((node) =>
      node.type === "TSPropertySignature" &&
      source.name(node.key) === "activity"
    ).length,
    0,
  );
  const css = await Deno.readTextFile("packages/ui/theme.css");
  assertEquals(
    css.includes(".otk-dot-connected"),
    false,
    "Connection paint must have one component owner",
  );
});
