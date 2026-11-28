// SPDX-License-Identifier: LGPL-3.0-only
/** Historical positions are now verified in the order owner's migration tests. */
export function withoutLegacyPositions<
  T extends Record<string, Record<string, unknown>[]>,
>(manifest: T): T {
  const result = structuredClone(manifest);
  for (const table of ["projects", "project_directories"]) {
    for (const row of result[table]) delete row.position;
  }
  return result;
}
