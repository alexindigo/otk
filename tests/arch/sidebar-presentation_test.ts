// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";

Deno.test("sidebar section counts must use the shared visit-clock metadata slot", async () => {
  const text = await Deno.readTextFile(
    new URL("../../packages/ui/components/ProjectInbox.tsx", import.meta.url),
  );
  const source = new Source(text);
  assertEquals(
    source.all.filter((node) =>
      node.type === "JSXOpeningElement" &&
      node.name.type === "JSXIdentifier" &&
      node.name.name === "SectionHeaderMeta"
    ).length,
    3,
  );
  assert(text.includes('class="otk-project-visit otk-chrome-meta"'));
  assert(
    !/\(\{(?:attention\(\)\.count|discovered\(\)\.length|inactiveRows\(\)\.length)\}\)/
      .test(text),
  );
  const slot = await Deno.readTextFile(
    new URL("../../packages/ui/components/ChromeMeta.tsx", import.meta.url),
  );
  assert(
    slot.includes(
      "<ChromeMeta class={props.metaClass}>{props.count}</ChromeMeta>",
    ),
  );
});
