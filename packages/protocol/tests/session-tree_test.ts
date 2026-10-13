// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { belongsToSession, sessionAncestors } from "../mod.ts";

const nodes: Record<string, { parentID?: string }> = {
  root: {},
  child: { parentID: "root" },
  grandchild: { parentID: "child" },
  other: {},
  cycleA: { parentID: "cycleB" },
  cycleB: { parentID: "cycleA" },
};
const lookup = (id: string) => nodes[id];
Deno.test("permission family follows every ancestor, isolates siblings and terminates cycles", () => {
  assertEquals(sessionAncestors("grandchild", lookup), ["child", "root"]);
  assert(belongsToSession("root", "root", lookup));
  assert(belongsToSession("grandchild", "root", lookup));
  assert(!belongsToSession("other", "root", lookup));
  assert(!belongsToSession("root", "child", lookup));
  assertEquals(sessionAncestors("cycleA", lookup), ["cycleB"]);
  assertEquals(sessionAncestors("missing", lookup), []);
});
