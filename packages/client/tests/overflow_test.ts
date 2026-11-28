// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fitOverflow, overflowPreference } from "../overflow.ts";
Deno.test("D66 progressive fitting compacts every title before aggregating the whole row", () => {
  const input = {
    keys: ["root", "a", "b"],
    widths: new Map([["root", 50], ["a", 150], ["b", 200]]),
    compactWidths: new Map([["root", 30], ["a", 70], ["b", 80]]),
    required: [],
    moreWidth: 0,
    gap: 4,
  };
  assertEquals(fitOverflow({ ...input, available: 408 }), {
    visible: input.keys,
    overflow: [],
    mode: "full",
  });
  assertEquals(fitOverflow({ ...input, available: 248 }), {
    visible: input.keys,
    overflow: [],
    mode: "compact",
    widths: new Map([["root", 50], ["a", 90], ["b", 100]]),
  });
  assertEquals(fitOverflow({ ...input, available: 188 }), {
    visible: input.keys,
    overflow: [],
    mode: "compact",
    widths: input.compactWidths,
  });
  assertEquals(fitOverflow({ ...input, available: 187 }), {
    visible: [],
    overflow: input.keys,
    mode: "collapsed",
    widths: new Map(),
  });
  assertEquals(
    fitOverflow({ ...input, available: 187, required: ["root", "b"] }),
    {
      visible: ["root", "b"],
      overflow: ["a"],
      mode: "collapsed",
      widths: new Map([["root", 30], ["b", 80]]),
    },
  );
  // D67: ancestry is never replaced by an aggregate. If whole first words
  // cannot fit, retain their measured minima in the shared horizontal lane.
  assertEquals(
    fitOverflow({ ...input, available: 100, required: input.keys }),
    {
      visible: input.keys,
      overflow: [],
      mode: "compact",
      widths: input.compactWidths,
    },
  );
  assertEquals(
    fitOverflow({
      ...input,
      available: 100,
      required: input.keys,
      scrollRequired: true,
    }),
    { visible: input.keys, overflow: [], mode: "scroll" },
  );
});
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
