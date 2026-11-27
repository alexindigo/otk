// SPDX-License-Identifier: LGPL-3.0-only
export const opencodeV2DigestMigrations: {
  readonly feature: string;
  readonly migrations: readonly {
    readonly version: number;
    readonly sql: URL;
  }[];
} = {
  feature: "opencode-v2-transcript-digest",
  migrations: [{
    version: 1,
    sql: new URL("./digest-migrations/001.sql", import.meta.url),
  }, {
    version: 2,
    sql: new URL("./digest-migrations/002.sql", import.meta.url),
  }, {
    version: 3,
    sql: new URL("./digest-migrations/003.sql", import.meta.url),
  }, {
    version: 4,
    sql: new URL("./digest-migrations/004.sql", import.meta.url),
  }, {
    version: 5,
    sql: new URL("./digest-migrations/005.sql", import.meta.url),
  }, {
    version: 6,
    sql: new URL("./digest-migrations/006.sql", import.meta.url),
  }, {
    version: 7,
    sql: new URL("./digest-migrations/007.sql", import.meta.url),
  }, {
    version: 8,
    sql: new URL("./digest-migrations/008.sql", import.meta.url),
  }],
};
