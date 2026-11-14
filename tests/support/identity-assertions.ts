// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertNotMatch } from "@std/assert";
import type { SessionIdentity } from "@otk/harness";

/** Identity readers own routing and ancestry, not additive published projections. */
export function assertIdentityFields(
  actual: readonly SessionIdentity[],
  expected: readonly SessionIdentity[],
) {
  const fields = (rows: readonly SessionIdentity[]) =>
    rows.map(({ id, directory, parentID }) => ({ id, directory, parentID }));
  assertEquals(fields(actual), fields(expected));
  assertNotMatch(
    JSON.stringify(actual),
    /"(?:password|totpkey|secretkey)"\s*:/i,
  );
}
