// SPDX-License-Identifier: LGPL-3.0-only
import type { FeatureMigrations } from "../migrations.ts";
export const digestMigrations: FeatureMigrations = {
  feature: "digest",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/digest/001.sql", import.meta.url),
  }, {
    version: 2,
    sql: new URL("./migrations/digest/002.sql", import.meta.url),
  }, {
    version: 3,
    sql: new URL("./migrations/digest/003.sql", import.meta.url),
  }],
};
