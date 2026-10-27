// SPDX-License-Identifier: LGPL-3.0-only
import type { FeatureMigrations } from "../migrations.ts";

export const sessionReferenceMigrations: FeatureMigrations = {
  feature: "session-reference-upgrade",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/session-references/001.sql", import.meta.url),
  }],
};
