// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";

/** Standalone consumer: no sidecar, HTTP routes, store or app configuration. */
export async function listSessions(
  harness: Harness,
  directory: string,
) {
  try {
    await harness.core.start({
      connection() {},
      indexReset() {},
      indexUpsert() {},
      indexRemove() {},
      content() {},
      bootstrapComplete() {},
      invalidate() {},
    });
    // Session population is demand-owned, not an implicit startup snapshot.
    return (await harness.core.listSessions({ directory, limit: 20 })).items;
  } finally {
    await harness.core.stop();
  }
}
