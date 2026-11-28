// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { laneStates, treePaths } from "../tree-paths.ts";

Deno.test("tree lanes derive paint from the row path and facts", () => {
  const row = { connected: true, art: true, stem: false };
  assertEquals(laneStates([], row), {
    ancestors: [],
    junction: "none",
    node: "art",
  });
  assertEquals(laneStates([false], row), {
    ancestors: ["blank"],
    junction: "elbow",
    node: "art",
  });
  assertEquals(laneStates([true], { ...row, art: false }), {
    ancestors: ["blank"],
    junction: "tee",
    node: "empty",
  });
  assertEquals(laneStates([true, false, true], { ...row, stem: true }), {
    ancestors: ["blank", "through", "blank"],
    junction: "tee",
    node: "stem",
  });
  assertEquals(laneStates([true, false], { ...row, connected: false }), {
    ancestors: ["blank", "through"],
    junction: "none",
    node: "art",
  });
});

Deno.test("tree lanes follow the sidebar session family in preorder", () => {
  const depths = [0, 1, 2, 1, 1];
  assertEquals(
    treePaths(depths, (depth) => depth).map((path, i) =>
      laneStates(path, { connected: i > 0, art: true, stem: i < 2 })
    ),
    [
      { ancestors: [], junction: "none", node: "stem" },
      { ancestors: ["blank"], junction: "tee", node: "stem" },
      { ancestors: ["blank", "through"], junction: "elbow", node: "art" },
      { ancestors: ["blank"], junction: "tee", node: "art" },
      { ancestors: ["blank"], junction: "elbow", node: "art" },
    ],
  );
});
