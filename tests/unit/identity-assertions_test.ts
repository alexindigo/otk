// SPDX-License-Identifier: LGPL-3.0-only
import { assertThrows } from "@std/assert";
import { assertIdentityFields } from "../support/identity-assertions.ts";

Deno.test("identity assertions permit additive facts but retain routing, ancestry, order and cardinality", () => {
  const parent = { id: "parent", directory: "/repo" };
  const child = { id: "child", directory: "/repo", parentID: parent.id };
  const enriched = { ...child, hierarchy: { rootID: parent.id } };
  assertIdentityFields([enriched], [child]);
  for (
    const changed of [
      { ...child, id: "other" },
      { ...child, directory: "/other" },
      { ...child, parentID: "other" },
      { id: child.id, directory: child.directory },
    ]
  ) assertThrows(() => assertIdentityFields([changed], [child]));
  assertThrows(() => assertIdentityFields([child], [parent]));
  assertThrows(() => assertIdentityFields([child, parent], [parent, child]));
  assertThrows(() => assertIdentityFields([child, child], [child]));
  assertThrows(() => assertIdentityFields([], [child]));
  for (const key of ["password", "totpkey", "secretkey"]) {
    const leaked = { ...child, additive: { [key]: "private" } };
    assertThrows(() => assertIdentityFields([leaked], [child]));
  }
});
