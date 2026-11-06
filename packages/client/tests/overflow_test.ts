// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fitOverflow, overflowPreference } from "../overflow.ts";
Deno.test("overflow partitions by measured width, preserving required identity and preference order", () => {
  const keys = ["root", "a", "b", "selected", "tail"],
    widths = new Map(keys.map((key) => [key, 80]));
  assertEquals(
    fitOverflow({
      keys,
      widths,
      available: 260,
      required: ["selected"],
      preferred: ["root", "b"],
      moreWidth: 28,
      gap: 4,
    }),
    { visible: ["root", "selected"], overflow: ["a", "b", "tail"] },
  );
  assertEquals(
    fitOverflow({
      keys,
      widths,
      available: 500,
      required: ["selected"],
      moreWidth: 28,
      gap: 4,
    }),
    { visible: keys, overflow: [] },
  );
  assertEquals(
    fitOverflow({
      keys,
      widths,
      available: 30,
      required: ["selected"],
      moreWidth: 28,
      gap: 4,
    }),
    { visible: ["selected"], overflow: ["root", "a", "b", "tail"] },
  );
});
Deno.test("overflow preference follows ancestry rather than adjacent unrelated chips", () => {
  const parents: Record<string, string> = {
    selected: "parent",
    parent: "grandparent",
    grandparent: "root",
  };
  assertEquals(
    overflowPreference(
      ["root", "unrelated", "grandparent", "parent", "selected"],
      "selected",
      (key) => parents[key],
    ),
    ["root", "parent", "grandparent", "unrelated", "selected"],
  );
  assertEquals(
    overflowPreference(
      ["root", "a", "b"],
      "b",
      (key) => key === "b" ? "a" : "b",
    ),
    ["root", "a", "b"],
  );
});

Deno.test("required crumbs remain available to shrink when their widths exceed the lane", () => {
  const input = {
    keys: ["other", "root", "parent", "selected", "editing", "tail"],
    widths: new Map(
      ["other", "root", "parent", "selected", "editing", "tail"].map(
        (key) => [key, 120],
      ),
    ),
    available: 300,
    required: ["root", "parent", "selected", "editing"],
    moreWidth: 28,
    gap: 4,
  };
  assertEquals<unknown>(fitOverflow(input), {
    visible: ["root", "parent", "selected", "editing"],
    overflow: ["other", "tail"],
  });
});
